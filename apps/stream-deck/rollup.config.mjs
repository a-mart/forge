import commonjs from '@rollup/plugin-commonjs'
import nodeResolve from '@rollup/plugin-node-resolve'
import terser from '@rollup/plugin-terser'
import typescript from '@rollup/plugin-typescript'

const isWatching = Boolean(process.env.ROLLUP_WATCH)

export default {
  input: 'src/plugin.ts',
  output: {
    file: 'com.forge.command-center.sdPlugin/bin/plugin.js',
    sourcemap: isWatching,
  },
  plugins: [
    typescript({
      tsconfig: './tsconfig.json',
      noEmit: false,
      declaration: false,
      declarationMap: false,
    }),
    nodeResolve({
      browser: false,
      exportConditions: ['node'],
      preferBuiltins: true,
    }),
    commonjs(),
    !isWatching && terser(),
    {
      name: 'emit-module-package-file',
      generateBundle() {
        this.emitFile({
          fileName: 'package.json',
          source: '{ "type": "module" }',
          type: 'asset',
        })
      },
    },
  ],
}
