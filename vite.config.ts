import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";

const repositoryName = "bravonetflightintelligence";

export default defineConfig({
  base: `/${repositoryName}/`,
  plugins: [react(), cesium()],
});
