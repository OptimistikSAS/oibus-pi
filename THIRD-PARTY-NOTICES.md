# Third-Party Notices

This package is licensed under the Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Bundled third-party components: none

The published Windows binary (`runtimes/win-x64/OIBusPiWindows.exe`) is built from this repository's
own source only (`Program.cs`, `AfSdk.cs`). It targets .NET Framework 4.8, which is part of Windows:
no .NET runtime and no third-party library is embedded in it.

The `Microsoft.NETFramework.ReferenceAssemblies` NuGet package (MIT License, Copyright (c) .NET
Foundation and Contributors) is used at build time only, to compile against .NET Framework 4.8. None
of its files is shipped.

## AVEVA AF SDK: not included

No AVEVA file is included in this package, in its binary, in its git repository or in its build.
The helper loads the .NET Framework AF SDK (`OSIsoft.AFSDK`) at runtime from the PI AF Client
installed on the machine by its owner, under the owner's own agreement with AVEVA, and calls it by
late binding. What this requires of you: [README.md](README.md#requirements-on-the-machine).
