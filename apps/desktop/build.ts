import { build } from 'vite'

await build()
// The main process and the preload script, each as one file. A sandboxed preload cannot load a second one.
for (const name of ['main', 'preload']) {
  await build({
    configFile: false,
    ssr: { noExternal: true },
    build: {
      ssr: `electron/${name}.ts`,
      outDir: 'dist/electron',
      emptyOutDir: name === 'main',
      target: 'node24',
      rollupOptions: {
        external: ['electron', 'bufferutil', 'utf-8-validate'],
        output: { format: 'cjs', entryFileNames: `${name}.cjs` },
      },
    },
  })
}
