cmake_minimum_required(VERSION 3.21)
project(kronos_editor LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if (NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Debug)
endif()

# Debug: frontend/ is read live from disk (fast edit-reload loop, but the
# built binary depends on the source tree being present at that path).
# Release: frontend/ is embedded into the binary at compile time as byte
# arrays (tools/embed_resources.py), so the packaged app ships as a single
# file with no loose HTML/JS/CSS to install alongside it.
option(EDITOR_EMBED_RESOURCES "Embed frontend/ into the binary instead of reading it from disk" OFF)
if (NOT EDITOR_EMBED_RESOURCES AND CMAKE_BUILD_TYPE STREQUAL "Release")
    set(EDITOR_EMBED_RESOURCES ON)
endif()

add_executable(kronos_editor
    src/main.cpp
    src/bridge/EditorBridge.cpp
    src/platform/NativeFileDialog.cpp
    src/kronos/PcgFile.cpp
    src/kronos/ProgramDecoder.cpp
    src/kronos/CombiDecoder.cpp
)

target_include_directories(kronos_editor PRIVATE
    src
    third_party/choc
)

target_compile_definitions(kronos_editor PRIVATE
    EDITOR_FRONTEND_DIR="${CMAKE_CURRENT_SOURCE_DIR}/frontend"
)

if (EDITOR_EMBED_RESOURCES)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)

    file(GLOB_RECURSE EDITOR_FRONTEND_ASSETS CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/frontend/*")

    set(EDITOR_EMBED_HEADER "${CMAKE_CURRENT_BINARY_DIR}/generated/EmbeddedAssets.h")
    set(EDITOR_EMBED_SOURCE "${CMAKE_CURRENT_BINARY_DIR}/generated/EmbeddedAssets.cpp")

    add_custom_command(
        OUTPUT "${EDITOR_EMBED_HEADER}" "${EDITOR_EMBED_SOURCE}"
        COMMAND Python3::Interpreter
                "${CMAKE_CURRENT_SOURCE_DIR}/tools/embed_resources.py"
                "${CMAKE_CURRENT_SOURCE_DIR}/frontend"
                "${EDITOR_EMBED_HEADER}"
                "${EDITOR_EMBED_SOURCE}"
        DEPENDS ${EDITOR_FRONTEND_ASSETS} "${CMAKE_CURRENT_SOURCE_DIR}/tools/embed_resources.py"
        COMMENT "Embedding frontend/ assets into the binary (release build)"
        VERBATIM
    )

    target_sources(kronos_editor PRIVATE "${EDITOR_EMBED_SOURCE}")
    target_include_directories(kronos_editor PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
    target_compile_definitions(kronos_editor PRIVATE EDITOR_EMBED_RESOURCES=1)
endif()

if (APPLE)
    target_link_libraries(kronos_editor PRIVATE "-framework WebKit" "-framework Cocoa")
elseif (${CMAKE_SYSTEM_NAME} MATCHES "Linux")
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(GTK3 REQUIRED gtk+-3.0)
    pkg_check_modules(WEBKIT2 REQUIRED webkit2gtk-4.1)

    target_include_directories(kronos_editor PRIVATE ${GTK3_INCLUDE_DIRS} ${WEBKIT2_INCLUDE_DIRS})
    target_link_libraries(kronos_editor PRIVATE ${GTK3_LIBRARIES} ${WEBKIT2_LIBRARIES})
    target_compile_options(kronos_editor PRIVATE ${GTK3_CFLAGS_OTHER} ${WEBKIT2_CFLAGS_OTHER})
elseif (WIN32)
    # choc's WebView on Windows uses WebView2 via embedded COM interop headers
    # and the OS-provided Evergreen runtime -- no extra link libraries needed.
endif()

# Scoped test target: only PcgFile.cpp/ProgramDecoder.cpp/CombiDecoder.cpp,
# no main.cpp, no EditorBridge.cpp, no CHOC/WebView -- so `ctest` (or
# building this target alone) stays fast and never needs a platform WebView
# toolchain. See tests/pcg_file_test.cpp and STATE.md's "ARCHITECTURE:
# DECODER/ENCODER REFACTOR" section for why this is kept separate from
# kronos_editor.
enable_testing()

add_executable(pcg_file_test
    tests/pcg_file_test.cpp
    src/kronos/PcgFile.cpp
    src/kronos/ProgramDecoder.cpp
    src/kronos/CombiDecoder.cpp
)

target_include_directories(pcg_file_test PRIVATE src)

add_test(NAME pcg_file_test COMMAND pcg_file_test)
