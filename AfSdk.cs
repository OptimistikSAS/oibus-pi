using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;

namespace OIBusPiWindows
{
    /// <summary>
    /// Late-bound access to the AF SDK of the PI AF Client installed on the machine.
    ///
    /// The helper has no compile-time reference to the AF SDK and ships none of its files. The assembly is
    /// loaded at runtime from the Global Assembly Cache, where PI AF Client registers it, or else from
    /// <c>%PIHOME%\AF\PublicAssemblies\4.0</c>. The few members used are looked up by name: static members
    /// and constructors through reflection, with their exact signature, and instance members through <c>dynamic</c>. Every type and static member is resolved when the SDK is
    /// loaded, so that a missing one is reported once, by name, instead of failing in the middle of a read.
    /// </summary>
    internal sealed class AfSdk
    {
        private const string AssemblyName = "OSIsoft.AFSDK, Version=4.0.0.0, Culture=neutral, PublicKeyToken=6238be57836698e6";
        private const string AssemblyFileName = "OSIsoft.AFSDK.dll";

        private readonly Type piServersType;
        private readonly MethodInfo findPointsByName;
        private readonly MethodInfo findPointsByQuery;
        private readonly object exactMatch;
        private readonly ConstructorInfo pointListConstructor;
        private readonly ConstructorInfo timeConstructor;
        private readonly ConstructorInfo timeRangeConstructor;
        private readonly ConstructorInfo pagingConstructor;
        private readonly object eventCountPage;
        private readonly object insideBoundary;

        public string Location { get; }

        private AfSdk(Assembly assembly)
        {
            Location = assembly.Location;
            piServersType = GetType(assembly, "OSIsoft.AF.PI.PIServers");
            var piServerType = GetType(assembly, "OSIsoft.AF.PI.PIServer");
            var piPointType = GetType(assembly, "OSIsoft.AF.PI.PIPoint");
            var pointListType = GetType(assembly, "OSIsoft.AF.PI.PIPointList");
            var timeType = GetType(assembly, "OSIsoft.AF.Time.AFTime");
            var timeRangeType = GetType(assembly, "OSIsoft.AF.Time.AFTimeRange");
            var pagingType = GetType(assembly, "OSIsoft.AF.PI.PIPagingConfiguration");
            var pageTypeType = GetType(assembly, "OSIsoft.AF.PI.PIPageType");
            var boundaryType = GetType(assembly, "OSIsoft.AF.Data.AFBoundaryType");
            var searchOptionType = GetType(assembly, "OSIsoft.AF.Search.AFSearchTextOption");

            // PIPoint.FindPIPoints(PIServer, IEnumerable<string> names, IEnumerable<string> attributeNames = null)
            findPointsByName = GetStaticMethod(piPointType, "FindPIPoints", piServerType, typeof(IEnumerable<string>), typeof(IEnumerable<string>));
            // PIPoint.FindPIPoints(PIServer, string query, bool searchNameAndDescriptor, IEnumerable<string> attributeNames = null,
            //                      AFSearchTextOption searchOption = AFSearchTextOption.ExactMatch)
            findPointsByQuery = GetStaticMethod(piPointType, "FindPIPoints", piServerType, typeof(string), typeof(bool), typeof(IEnumerable<string>), searchOptionType);
            exactMatch = GetEnumValue(searchOptionType, "ExactMatch");
            // new PIPointList(IEnumerable<PIPoint>)
            pointListConstructor = GetConstructor(pointListType, typeof(IEnumerable<>).MakeGenericType(piPointType));
            // new AFTime(DateTime), new AFTimeRange(AFTime, AFTime)
            timeConstructor = GetConstructor(timeType, typeof(DateTime));
            timeRangeConstructor = GetConstructor(timeRangeType, timeType, timeType);
            // new PIPagingConfiguration(PIPageType, int)
            pagingConstructor = GetConstructor(pagingType, pageTypeType, typeof(int));
            eventCountPage = GetEnumValue(pageTypeType, "EventCount");
            insideBoundary = GetEnumValue(boundaryType, "Inside");
        }

        public static AfSdk Load()
        {
            return new AfSdk(LoadAssembly());
        }

        /// <summary>The PI Data Archive of the known servers table with this name, or the default one when no name is given</summary>
        public dynamic FindServer(string serverName)
        {
            dynamic servers = Activator.CreateInstance(piServersType);
            dynamic server = string.IsNullOrWhiteSpace(serverName) ? servers.DefaultPIServer : servers[serverName.Trim()];
            if (server == null)
            {
                throw new AfSdkException(
                    string.IsNullOrWhiteSpace(serverName)
                        ? "No default PI Data Archive is set in the known servers table of PI AF Client"
                        : $"PI Data Archive \"{serverName.Trim()}\" is not in the known servers table of PI AF Client"
                );
            }
            return server;
        }

        /// <summary>The points of these exact names (no wildcard) found on the server. A name not found is left out.</summary>
        public IList<object> FindPointsByName(object server, IList<string> names)
        {
            return ToList(Invoke(findPointsByName, server, names, null));
        }

        /// <summary>
        /// The points matching a PI point query (see AVEVA's "PIPoint Query Syntax"). A query without attribute name, such as
        /// <c>sinus*</c>, searches the point names.
        /// </summary>
        public IList<object> FindPointsByQuery(object server, string query)
        {
            return ToList(Invoke(findPointsByQuery, server, query, false, null, exactMatch));
        }

        /// <summary>
        /// The recorded values of the points between two instants, both included, read in bulk and paged by event count.
        /// With a filter expression (performance equation syntax), the PI Data Archive only returns the values passing it.
        /// Returns one entry per point, with its name and its values (<c>AFValues</c>).
        /// </summary>
        public IList<KeyValuePair<string, IEnumerable>> RecordedValues(
            IList<object> points,
            DateTime startTime,
            DateTime endTime,
            int pageSize,
            string filterExpression = null
        )
        {
            var result = new List<KeyValuePair<string, IEnumerable>>();
            if (points.Count == 0)
            {
                return result;
            }
            dynamic pointList = Construct(pointListConstructor, CastToPointEnumerable(points));
            dynamic timeRange = Construct(timeRangeConstructor, Construct(timeConstructor, startTime), Construct(timeConstructor, endTime));
            dynamic paging = Construct(pagingConstructor, eventCountPage, pageSize);
            try
            {
                // The results are enumerated (and fetched from the server) lazily: errors of the bulk calls surface here.
                // The values failing the filter are left out (includeFilteredValues: false), not replaced by "Filtered" markers.
                foreach (dynamic values in (IEnumerable)pointList.RecordedValues(timeRange, (dynamic)insideBoundary, filterExpression, false, paging))
                {
                    string name = values.PIPoint.Name;
                    result.Add(new KeyValuePair<string, IEnumerable>(name, (IEnumerable)values));
                }
            }
            catch (OperationCanceledException ex)
            {
                // The bulk calls report their error on the paging configuration
                Exception error = paging.Error;
                if (error != null)
                {
                    throw new AfSdkException(error.Message, error);
                }
                throw new AfSdkException(ex.Message, ex);
            }
            return result;
        }

        private object CastToPointEnumerable(IList<object> points)
        {
            // An IEnumerable<PIPoint>: Enumerable.Cast<PIPoint>(points)
            var pointType = pointListConstructor.GetParameters()[0].ParameterType.GetGenericArguments()[0];
            var cast = typeof(Enumerable).GetMethod(nameof(Enumerable.Cast)).MakeGenericMethod(pointType);
            var toList = typeof(Enumerable).GetMethod(nameof(Enumerable.ToList)).MakeGenericMethod(pointType);
            return toList.Invoke(null, new[] { cast.Invoke(null, new object[] { points }) });
        }

        private static Assembly LoadAssembly()
        {
            try
            {
                return Assembly.Load(AssemblyName);
            }
            catch (Exception ex) when (ex is FileNotFoundException || ex is FileLoadException || ex is BadImageFormatException)
            {
                // Not in the Global Assembly Cache: look in the PI installation folder
            }

            foreach (var folder in PublicAssemblyFolders())
            {
                var path = Path.Combine(folder, AssemblyFileName);
                if (!File.Exists(path))
                {
                    continue;
                }
                // The AF SDK loads its own dependencies from the same folder
                AppDomain.CurrentDomain.AssemblyResolve += (_, args) =>
                {
                    var dependency = Path.Combine(folder, new AssemblyName(args.Name).Name + ".dll");
                    return File.Exists(dependency) ? Assembly.LoadFrom(dependency) : null;
                };
                return Assembly.LoadFrom(path);
            }

            throw new AfSdkException(
                "PI AF Client is not installed: the AF SDK (OSIsoft.AFSDK) was found neither in the Global Assembly Cache nor in %PIHOME%\\AF\\PublicAssemblies\\4.0"
            );
        }

        private static IEnumerable<string> PublicAssemblyFolders()
        {
            var homes = new[]
            {
                Environment.GetEnvironmentVariable("PIHOME64"),
                Environment.GetEnvironmentVariable("PIHOME"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PIPC"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "PIPC")
            };
            return homes
                .Where(home => !string.IsNullOrWhiteSpace(home))
                .Select(home => Path.Combine(home, "AF", "PublicAssemblies", "4.0"))
                .Distinct(StringComparer.OrdinalIgnoreCase);
        }

        private static Type GetType(Assembly assembly, string name)
        {
            return assembly.GetType(name, false) ?? throw Missing(name);
        }

        private static MethodInfo GetStaticMethod(Type type, string name, params Type[] parameters)
        {
            return type.GetMethod(name, BindingFlags.Public | BindingFlags.Static, null, parameters, null)
                ?? throw Missing($"{type.FullName}.{name}({string.Join(", ", parameters.Select(parameter => parameter.Name))})");
        }

        private static ConstructorInfo GetConstructor(Type type, params Type[] parameters)
        {
            return type.GetConstructor(parameters)
                ?? throw Missing($"{type.FullName}({string.Join(", ", parameters.Select(parameter => parameter.Name))})");
        }

        private static object GetEnumValue(Type type, string name)
        {
            if (!type.IsEnum || !Enum.IsDefined(type, name))
            {
                throw Missing($"{type.FullName}.{name}");
            }
            return Enum.Parse(type, name);
        }

        private static Exception Missing(string member)
        {
            return new AfSdkException($"The installed AF SDK has no {member}: this version of PI AF Client is not supported");
        }

        private static object Invoke(MethodInfo method, params object[] arguments)
        {
            try
            {
                return method.Invoke(null, arguments);
            }
            catch (TargetInvocationException ex) when (ex.InnerException != null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
                throw;
            }
        }

        private static object Construct(ConstructorInfo constructor, params object[] arguments)
        {
            try
            {
                return constructor.Invoke(arguments);
            }
            catch (TargetInvocationException ex) when (ex.InnerException != null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
                throw;
            }
        }

        private static IList<object> ToList(object enumerable)
        {
            return enumerable == null ? new List<object>() : ((IEnumerable)enumerable).Cast<object>().ToList();
        }
    }

    /// <summary>An error whose message is meaningful on its own (no exception type prefix needed)</summary>
    internal sealed class AfSdkException : Exception
    {
        public AfSdkException(string message, Exception inner = null) : base(message, inner)
        {
        }
    }
}
