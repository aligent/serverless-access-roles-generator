import * as esbuild from 'esbuild';
import pkg from './package.json' assert { type: 'json' };

const result = await esbuild.build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    minify: false,
    sourcemap: true,
    platform: 'node',
    target: ['node18.0'],
    outdir: '.esbuild',
    external: [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.peerDependencies || {}),
    ],
    banner: {
        js: '/* eslint-disable no-undef */\n/* eslint-disable @typescript-eslint/no-var-requires */',
    },
});

if (result.errors.length > 0) {
    console.error(errors);
} else {
    console.log('esbuild succeed!');
}
