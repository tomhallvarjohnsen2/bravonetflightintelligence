import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repositoryName = "bravonetflightintelligence";

export default defineConfig({
  base: `/${repositoryName}/`,
  plugins: [react()],
});
