# Keep the library static while using the same CRT as the Rust application.
set(WITH_CRT_DLL ON CACHE BOOL "Use the shared MSVC runtime")
