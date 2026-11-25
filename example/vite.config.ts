import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../",
  // Vite transforms TSX with the automatic JSX runtime on its own; the react
  // plugin was only adding Fast Refresh, which a demo page does not need.
  esbuild: { jsx: "automatic" },
});
