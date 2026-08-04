#include <fstream>
#include <iostream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

// Include order matters on Linux: choc_DesktopWindow.h uses GTK types
// (GdkDragContext, GtkWidget, ...) without including <gtk/gtk.h> itself --
// it relies on a header included earlier having already pulled that in.
// choc_MessageLoop.h/choc_WebView.h both do (CHOC_LINUX branch), so either
// must come first, or this fails to compile on Linux with "has not been
// declared" errors for basic GTK types.
#include "choc/gui/choc_MessageLoop.h"
#include "choc/gui/choc_DesktopWindow.h"
#include "choc/gui/choc_WebView.h"

#include "bridge/EditorBridge.h"

#ifdef EDITOR_EMBED_RESOURCES
#include "generated/EmbeddedAssets.h"
#endif

namespace {

std::string mimeTypeFor(const std::string& path) {
    if (path.size() >= 5 && path.compare(path.size() - 5, 5, ".html") == 0) return "text/html";
    if (path.size() >= 3 && path.compare(path.size() - 3, 3, ".js") == 0) return "application/javascript";
    if (path.size() >= 4 && path.compare(path.size() - 4, 4, ".css") == 0) return "text/css";
    return "application/octet-stream";
}

#ifdef EDITOR_EMBED_RESOURCES

// Release build: served straight out of the binary, no files on disk needed.
std::optional<choc::ui::WebView::Options::Resource> loadFrontendResource(const std::string& relative,
                                                                          const std::string&) {
    for (const auto& file : editor_embedded::getEmbeddedFiles()) {
        if (relative == file.path) {
            choc::ui::WebView::Options::Resource resource;
            resource.data.assign(file.data, file.data + file.size);
            resource.mimeType = mimeTypeFor(relative);
            return resource;
        }
    }
    return std::nullopt;
}

#else

// Debug build: read live off disk so editing frontend/ doesn't require a rebuild.
std::optional<choc::ui::WebView::Options::Resource> loadFrontendResource(const std::string& relative,
                                                                          const std::string& frontendDir) {
    std::ifstream file(frontendDir + relative, std::ios::binary);
    if (!file) return std::nullopt;

    std::ostringstream ss;
    ss << file.rdbuf();
    const auto content = ss.str();

    choc::ui::WebView::Options::Resource resource;
    resource.data.assign(content.begin(), content.end());
    resource.mimeType = mimeTypeFor(relative);
    return resource;
}

#endif

}  // namespace

int main() {
    const std::string frontendDir = EDITOR_FRONTEND_DIR;

    choc::ui::setWindowsDPIAwareness();
    choc::messageloop::initialise();

    choc::ui::DesktopWindow window({100, 100, 1100, 650});
    window.setWindowTitle("DIY Kronos Editor (jens-goes-mad with claude)");
    window.setResizable(true);
    window.setMinimumSize(800, 500);
    window.windowClosed = [] { choc::messageloop::stop(); };

    EditorBridge bridge;

    choc::ui::WebView::Options options;
    options.enableDebugMode = true;

    options.fetchResource = [&frontendDir](const std::string& path)
        -> std::optional<choc::ui::WebView::Options::Resource> {
        std::string relative = (path.empty() || path == "/") ? "/index.html" : path;
        return loadFrontendResource(relative, frontendDir);
    };

    options.webviewIsReady = [&bridge](choc::ui::WebView& view) {
        view.bind("openFile", [&bridge](const choc::value::ValueView& args) { return bridge.openFile(args); });
        view.bind("openFileDialog",
                   [&bridge](const choc::value::ValueView& args) { return bridge.openFileDialog(args); });
        view.bind("listDatasets",
                   [&bridge](const choc::value::ValueView& args) { return bridge.listDatasets(args); });
        view.bind("closeDataset",
                   [&bridge](const choc::value::ValueView& args) { return bridge.closeDataset(args); });
        view.bind("listSetlists",
                   [&bridge](const choc::value::ValueView& args) { return bridge.listSetlists(args); });
        view.bind("getEntries", [&bridge](const choc::value::ValueView& args) { return bridge.getEntries(args); });
        view.bind("moveEntry", [&bridge](const choc::value::ValueView& args) { return bridge.moveEntry(args); });
        view.bind("copyEntry", [&bridge](const choc::value::ValueView& args) { return bridge.copyEntry(args); });
        view.bind("setComment", [&bridge](const choc::value::ValueView& args) { return bridge.setComment(args); });
        view.bind("listPrograms",
                   [&bridge](const choc::value::ValueView& args) { return bridge.listPrograms(args); });
        view.bind("listCombis", [&bridge](const choc::value::ValueView& args) { return bridge.listCombis(args); });
        view.bind("getProgramUsage",
                   [&bridge](const choc::value::ValueView& args) { return bridge.getProgramUsage(args); });
        view.bind("findDuplicatePrograms",
                   [&bridge](const choc::value::ValueView& args) { return bridge.findDuplicatePrograms(args); });
    };

    auto webView = std::make_unique<choc::ui::WebView>(options);
    if (!webView->loadedOK()) {
        std::cerr << "Failed to create WebView (no suitable OS web engine found)\n";
        return 1;
    }

    window.setContent(webView->getViewHandle());
    window.setVisible(true);
    window.toFront();

    choc::messageloop::run();
    return 0;
}
