import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react-swc";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import loadTailwindConfig from "tailwindcss/loadConfig.js";
import { defineConfig } from "vite";

const theme = loadTailwindConfig(fileURLToPath(new URL("./tailwind.config.ts", import.meta.url)));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src/", import.meta.url)) } },
  css: {
    postcss: {
      plugins: [tailwindcss({ ...theme, content: ["./src/pilot/*.tsx", "./src/components/ui/{button,input,label}.tsx"] }), autoprefixer()],
    },
  },
  build: {
    outDir: "pilot-dist", emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("./pilot-index.html", import.meta.url)) },
  },
  publicDir: false,
  envDir: false,
});
