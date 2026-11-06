using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace OIBusPiWindows
{
    /// <summary>
    /// A single process shared by every caller of this package's PiBridge/PiConnection. Each logical connection is keyed
    /// by a UUID `id` and bound to a PI Data Archive of the known servers table.
    ///
    /// Commands on the same connection id run in the order they arrived, while commands on different ids run
    /// concurrently. Every request/response carries a `requestId` for out-of-order correlation. stdin/stdout are read and
    /// written as UTF-8 explicitly: the console code page would otherwise garble non-ASCII point names.
    ///
    /// The AF SDK keeps one PIServer object per PI Data Archive in the process: logical connections to the same server
    /// share it. It is disconnected when its last logical connection disconnects.
    /// </summary>
    internal static class Program
    {
        private const int DefaultPageSize = 20_000;
        private const long MaxSafeInteger = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER on the JavaScript side

        // PI network errors after which the connection to the server is unusable: the server is disconnected, and the next
        // command connects it again.
        private static readonly string[] ConnectionErrorCodes = { "[-10722]", "[-10723]", "[-10733]", "[-10734]" };

        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 16 };
        private static readonly Lazy<AfSdk> Sdk = new Lazy<AfSdk>(AfSdk.Load, LazyThreadSafetyMode.ExecutionAndPublication);
        private static readonly ConcurrentDictionary<string, object> Connections = new ConcurrentDictionary<string, object>();
        private static readonly Dictionary<object, int> ServerReferences = new Dictionary<object, int>();
        private static readonly ConcurrentDictionary<string, Task> LastOperationByConnection = new ConcurrentDictionary<string, Task>();
        private static readonly object StdoutLock = new object();
        private static StreamWriter stdout;

        private static int Main()
        {
            var utf8 = new UTF8Encoding(false);
            using (var stdin = new StreamReader(Console.OpenStandardInput(), utf8))
            using (stdout = new StreamWriter(Console.OpenStandardOutput(), utf8))
            {
                string line;
                while ((line = stdin.ReadLine()) != null)
                {
                    if (line.Length > 0)
                    {
                        ScheduleLine(line);
                    }
                }
                // Drain everything chained per connection before exiting: a short-lived piped run could otherwise hit stdin EOF
                // and return before its own dispatched work executed.
                Task.WaitAll(LastOperationByConnection.Values.ToArray());
            }
            foreach (var id in Connections.Keys.ToList())
            {
                Disconnect(id);
            }
            return 0;
        }

        private static void ScheduleLine(string line)
        {
            Dictionary<string, object> request;
            string requestId;
            string id;
            try
            {
                request = Json.Deserialize<Dictionary<string, object>>(line) ?? throw new FormatException("Empty request");
                requestId = GetString(request, "requestId");
                id = GetString(request, "id") ?? "";
            }
            catch (Exception ex)
            {
                WriteResponse(Failure(ex), null);
                return;
            }

            LastOperationByConnection.AddOrUpdate(
                id,
                _ => Task.Run(() => ProcessRequest(request, requestId)),
                (_, previous) => previous.ContinueWith(_ => ProcessRequest(request, requestId), TaskScheduler.Default)
            );
        }

        private static void ProcessRequest(Dictionary<string, object> request, string requestId)
        {
            Dictionary<string, object> response;
            try
            {
                var command = GetString(request, "command");
                var id = GetString(request, "id") ?? "";
                switch (command)
                {
                    case "connect":
                        response = HandleConnect(id, request);
                        break;
                    case "read":
                        response = HandleRead(id, request);
                        break;
                    case "disconnect":
                        Disconnect(id);
                        response = new Dictionary<string, object> { ["ok"] = true };
                        break;
                    default:
                        response = new Dictionary<string, object> { ["error"] = $"Unknown command '{command}'" };
                        break;
                }
            }
            catch (Exception ex)
            {
                response = Failure(ex);
            }
            WriteResponse(response, requestId);
        }

        private static void WriteResponse(Dictionary<string, object> response, string requestId)
        {
            if (requestId != null)
            {
                response["requestId"] = requestId;
            }
            var json = Json.Serialize(response);
            lock (StdoutLock)
            {
                stdout.WriteLine(json);
                stdout.Flush();
            }
        }

        /// <summary>
        /// AF SDK and timeout errors carry a meaningful message on their own (PI errors start with their code, such as
        /// "[-10722] PINET: Timeout on PI RPC or System Call"); anything else is prefixed with its type.
        /// </summary>
        private static Dictionary<string, object> Failure(Exception ex)
        {
            return new Dictionary<string, object> { ["error"] = Message(ex) };
        }

        private static string Message(Exception ex)
        {
            if (ex is AggregateException aggregate && aggregate.InnerExceptions.Count == 1)
            {
                ex = aggregate.InnerExceptions[0];
            }
            var meaningful = ex is AfSdkException
                || ex is TimeoutException
                || (ex.GetType().Namespace ?? "").StartsWith("OSIsoft.", StringComparison.Ordinal)
                || ex.Message.StartsWith("[-", StringComparison.Ordinal);
            return meaningful ? ex.Message : $"{ex.GetType().Name}: {ex.Message}";
        }

        /// <summary>
        /// Idempotent: a connection already open is checked (and connected again if the server was disconnected). The
        /// server is the one named by `serverName` in the known servers table of PI AF Client, or its default one.
        /// </summary>
        private static Dictionary<string, object> HandleConnect(string id, Dictionary<string, object> request)
        {
            var timeout = GetMilliseconds(request, "connectionTimeout");
            if (!Connections.TryGetValue(id, out object server))
            {
                server = (object)Sdk.Value.FindServer(GetString(request, "serverName"));
                WithTimeout(() => EnsureConnected(server), timeout, $"Connection timed out after {timeout} ms");
                Connections[id] = server;
                lock (ServerReferences)
                {
                    ServerReferences[server] = ServerReferences.TryGetValue(server, out int count) ? count + 1 : 1;
                }
            }
            else
            {
                WithTimeout(() => EnsureConnected(server), timeout, $"Connection timed out after {timeout} ms");
            }

            dynamic piServer = server;
            return new Dictionary<string, object>
            {
                ["ok"] = true,
                ["info"] = new Dictionary<string, object>
                {
                    ["name"] = TryGet(() => (string)piServer.Name),
                    ["version"] = TryGet(() => (string)piServer.ServerVersion),
                    ["uniqueId"] = TryGet(() => (string)piServer.UniqueID)
                }
            };
        }

        private static bool EnsureConnected(object serverObject)
        {
            dynamic server = serverObject;
            lock (serverObject)
            {
                if (!(bool)server.ConnectionInfo.IsConnected)
                {
                    // Windows integrated security of the account running the helper; never a credential prompt
                    server.Connect(false);
                }
            }
            return true;
        }

        private static void Disconnect(string id)
        {
            if (!Connections.TryRemove(id, out object server))
            {
                return;
            }
            lock (ServerReferences)
            {
                var count = ServerReferences.TryGetValue(server, out int references) ? references - 1 : 0;
                if (count > 0)
                {
                    ServerReferences[server] = count;
                    return;
                }
                ServerReferences.Remove(server);
            }
            DisconnectServer(server);
        }

        private static void DisconnectServer(object serverObject)
        {
            try
            {
                lock (serverObject)
                {
                    ((dynamic)serverObject).Disconnect();
                }
            }
            catch (Exception)
            {
                // Best effort: the connection may already be gone
            }
        }

        /// <summary>
        /// Reads the recorded values of points between two instants (both included), for points given by exact name and
        /// for points matching PI point queries, each with an optional filter expression (performance equation syntax),
        /// applied by the PI Data Archive: only the values passing it are returned.
        ///
        /// A bulk call takes one filter for all its points: the named points are read in one bulk call per distinct filter
        /// (one call when no point has a filter), and each query in its own call. A group or a query that fails is reported
        /// in the response, and the others are still read. A lost connection to the server fails the whole read, and
        /// disconnects the server: the next command connects it again.
        /// </summary>
        private static Dictionary<string, object> HandleRead(string id, Dictionary<string, object> request)
        {
            if (!Connections.TryGetValue(id, out object server))
            {
                return new Dictionary<string, object> { ["error"] = "Not connected" };
            }
            var startTime = GetInstant(request, "startTime");
            var endTime = GetInstant(request, "endTime");
            var points = GetFiltered(request, "points", "name");
            var queries = GetFiltered(request, "queries", "query");
            var pageSize = GetMilliseconds(request, "pageSize");
            var timeout = GetMilliseconds(request, "timeout");

            try
            {
                return WithTimeout(
                    () => Read(server, startTime, endTime, points, queries, pageSize > 0 ? pageSize : DefaultPageSize),
                    timeout,
                    $"Read timed out after {timeout} ms"
                );
            }
            catch (Exception ex) when (IsConnectionError(ex))
            {
                DisconnectServer(server);
                throw;
            }
        }

        private static Dictionary<string, object> Read(
            object server,
            DateTime startTime,
            DateTime endTime,
            List<KeyValuePair<string, string>> points,
            List<KeyValuePair<string, string>> queries,
            int pageSize
        )
        {
            var sdk = Sdk.Value;
            EnsureConnected(server);

            var found = new List<object>();
            var notFound = new List<string>();
            var pointsErrors = new List<object>();
            // One bulk call per distinct filter, in the order of their first point
            foreach (var group in points.GroupBy(point => point.Value))
            {
                var filter = group.Key;
                var names = group.Select(point => point.Key).Distinct().ToList();
                try
                {
                    var pointObjects = sdk.FindPointsByName(server, names);
                    // PI point names are not case-sensitive: the server returns its own spelling
                    var foundNames = new HashSet<string>(pointObjects.Select(point => (string)((dynamic)point).Name), StringComparer.OrdinalIgnoreCase);
                    var valuesByPoint = sdk.RecordedValues(pointObjects, startTime, endTime, pageSize, filter)
                        .GroupBy(entry => entry.Key, StringComparer.OrdinalIgnoreCase)
                        .ToDictionary(entries => entries.Key, entries => entries.First(), StringComparer.OrdinalIgnoreCase);
                    foreach (var name in names)
                    {
                        if (!foundNames.Contains(name))
                        {
                            if (!notFound.Contains(name))
                            {
                                notFound.Add(name);
                            }
                            continue;
                        }
                        var result = valuesByPoint.TryGetValue(name, out var entry)
                            ? PointValues(entry, name)
                            : new Dictionary<string, object> { ["name"] = name, ["point"] = name, ["values"] = new object[0] };
                        WithFilter(result, filter);
                        found.Add(result);
                    }
                }
                catch (Exception ex) when (!IsConnectionError(ex))
                {
                    pointsErrors.Add(WithFilter(new Dictionary<string, object> { ["names"] = names, ["error"] = Message(ex) }, filter));
                }
            }

            var queryResults = new List<object>();
            foreach (var query in queries)
            {
                var queryResult = WithFilter(new Dictionary<string, object> { ["query"] = query.Key }, query.Value);
                try
                {
                    var pointObjects = sdk.FindPointsByQuery(server, query.Key);
                    queryResult["points"] = sdk.RecordedValues(pointObjects, startTime, endTime, pageSize, query.Value)
                        .Select(entry => PointValues(entry, null))
                        .ToList();
                }
                catch (Exception ex) when (!IsConnectionError(ex))
                {
                    queryResult["points"] = new object[0];
                    queryResult["error"] = Message(ex);
                }
                queryResults.Add(queryResult);
            }

            return new Dictionary<string, object>
            {
                ["points"] = found,
                ["notFound"] = notFound,
                ["pointsErrors"] = pointsErrors,
                ["queries"] = queryResults
            };
        }

        private static Dictionary<string, object> WithFilter(Dictionary<string, object> result, string filter)
        {
            if (filter != null)
            {
                result["filter"] = filter;
            }
            return result;
        }

        /// <summary>The values of a point, each as [timestamp, value, good]</summary>
        private static Dictionary<string, object> PointValues(KeyValuePair<string, IEnumerable> entry, string requestedName)
        {
            var values = new List<object>();
            foreach (dynamic value in entry.Value)
            {
                DateTime timestamp = value.Timestamp.UtcTime;
                object raw = value.Value;
                bool good = value.IsGood;
                values.Add(new[] { FormatInstant(timestamp), ToJson(raw), good });
            }
            var result = new Dictionary<string, object> { ["point"] = entry.Key, ["values"] = values };
            if (requestedName != null)
            {
                result["name"] = requestedName;
            }
            return result;
        }

        /// <summary>
        /// JSON representation of a PI value:
        /// - numbers as JSON numbers, except 64-bit integers beyond JavaScript's safe range and non-finite floating-point
        ///   values, sent as strings so that no digit is silently lost; a single-precision float keeps its shortest
        ///   representation (1.1, not 1.100000023841858);
        /// - digital states (AFEnumerationValue) by their name, such as "On" or "I/O Timeout";
        /// - timestamps as ISO 8601 UTC strings, binary data in base64, anything else as its invariant-culture string.
        /// </summary>
        private static object ToJson(object value)
        {
            var invariant = CultureInfo.InvariantCulture;
            switch (value)
            {
                case null:
                case DBNull _:
                    return null;
                case string text:
                    return text;
                case bool boolean:
                    return boolean;
                case sbyte _:
                case byte _:
                case short _:
                case ushort _:
                case int _:
                case uint _:
                    return Convert.ToInt64(value, invariant);
                case long number:
                    return number >= -MaxSafeInteger && number <= MaxSafeInteger ? (object)number : number.ToString(invariant);
                case ulong number:
                    return number <= MaxSafeInteger ? (object)number : number.ToString(invariant);
                case float number:
                    return float.IsNaN(number) || float.IsInfinity(number)
                        ? (object)number.ToString(invariant)
                        : double.Parse(number.ToString("R", invariant), invariant);
                case double number:
                    return double.IsNaN(number) || double.IsInfinity(number) ? (object)number.ToString("R", invariant) : number;
                case decimal number:
                    return number;
                case DateTime dateTime:
                    return FormatInstant(dateTime.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(dateTime, DateTimeKind.Utc) : dateTime.ToUniversalTime());
                case byte[] bytes:
                    return Convert.ToBase64String(bytes);
            }
            if (value.GetType().FullName == "OSIsoft.AF.Asset.AFEnumerationValue")
            {
                return (string)((dynamic)value).Name;
            }
            return Convert.ToString(value, invariant);
        }

        private static bool IsConnectionError(Exception ex)
        {
            var text = ex.ToString();
            return ConnectionErrorCodes.Any(code => text.Contains(code));
        }

        private static T WithTimeout<T>(Func<T> action, int timeoutMs, string timeoutMessage)
        {
            if (timeoutMs <= 0)
            {
                return action();
            }
            var task = Task.Run(action);
            try
            {
                if (!task.Wait(timeoutMs))
                {
                    // The AF SDK call cannot be cancelled: it completes in the background, and its result is dropped
                    task.ContinueWith(t => t.Exception, TaskContinuationOptions.OnlyOnFaulted);
                    throw new TimeoutException(timeoutMessage);
                }
                return task.Result;
            }
            catch (AggregateException ex) when (ex.InnerExceptions.Count == 1)
            {
                ExceptionDispatchInfo.Capture(ex.InnerExceptions[0]).Throw();
                throw;
            }
        }

        private static string FormatInstant(DateTime utc)
        {
            return utc.ToString("yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fff'Z'", CultureInfo.InvariantCulture);
        }

        private static T TryGet<T>(Func<T> getter)
        {
            try
            {
                return getter();
            }
            catch (Exception)
            {
                return default;
            }
        }

        private static string GetString(Dictionary<string, object> request, string key)
        {
            return request.TryGetValue(key, out var value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;
        }

        /// <summary>
        /// The entries of a list of `{ [nameKey]: string, filter?: string }` objects, as (name, filter) pairs, the filter
        /// null when missing or blank. A plain string entry is a name without filter.
        /// </summary>
        private static List<KeyValuePair<string, string>> GetFiltered(Dictionary<string, object> request, string key, string nameKey)
        {
            var result = new List<KeyValuePair<string, string>>();
            if (!request.TryGetValue(key, out var value) || value == null)
            {
                return result;
            }
            foreach (var item in (IEnumerable)value)
            {
                if (item is Dictionary<string, object> entry)
                {
                    var filter = GetString(entry, "filter");
                    result.Add(new KeyValuePair<string, string>(GetString(entry, nameKey) ?? "", string.IsNullOrWhiteSpace(filter) ? null : filter.Trim()));
                }
                else
                {
                    result.Add(new KeyValuePair<string, string>(Convert.ToString(item, CultureInfo.InvariantCulture), null));
                }
            }
            return result;
        }

        private static int GetMilliseconds(Dictionary<string, object> request, string key)
        {
            if (!request.TryGetValue(key, out var value) || value == null)
            {
                return 0;
            }
            var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            return (int)Math.Max(0, Math.Min(int.MaxValue, number));
        }

        private static DateTime GetInstant(Dictionary<string, object> request, string key)
        {
            var text = GetString(request, key) ?? throw new FormatException($"Missing {key}");
            return DateTime.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
        }
    }
}
