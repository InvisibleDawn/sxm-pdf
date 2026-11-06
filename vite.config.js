export default {
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
};
