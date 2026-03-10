import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
function resolveAppVersion() {
    var commitCount = 0;
    try {
        var raw = execSync('git rev-list --count HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
        var parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            commitCount = parsed;
        }
    }
    catch (_a) {
        // Ignore git lookup failures in non-git build contexts.
    }
    return "v1.0.".concat(commitCount);
}
// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    define: {
        __APP_VERSION__: JSON.stringify(resolveAppVersion())
    },
    optimizeDeps: {
        exclude: ['pdfjs-dist']
    }
});
