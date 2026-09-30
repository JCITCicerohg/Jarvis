import { searchForWorkspaceRoot } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// JARVIS_API_PORT lets the self-modification test instance (in .workspace/) talk to its own API.
const api = `http://localhost:${process.env.JARVIS_API_PORT || 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': api },
    // Jarvis's own data and its self-modification workspace are not live app source.
    watch: { ignored: ['**/data/**', '**/.workspace/**'] },
    // The test instance runs from .workspace/ and uses the app's node_modules one folder up (icon fonts etc.).
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), ...(process.env.JARVIS_TEST_INSTANCE ? ['..'] : [])] },
  },
  test: { exclude: [...configDefaults.exclude, '.workspace/**', 'data/**'] },
});
