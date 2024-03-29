# rollup-plugin-natives

[![npm Version](https://badge.fury.io/js/rollup-plugin-natives.png)](https://npmjs.org/package/rollup-plugin-natives)

Extract native modules (.node files) while creating a rollup bundle and put them in one place"


## Installation

```bash
npm install --save-dev rollup-plugin-natives
```


## Usage

In some cases you have native dependencies (usually required by `bindings` or `node-pre-gyp`) 
and you have to put them somewhere accessible to the rolled-up bundle.  
This package is just for doing exactly this.

```js
// rollup.config.js
import nativePlugin from 'rollup-plugin-natives';

export default {
    input: 'main.js',
    output: {
        file: 'dist/bundle.js',
        format: 'cjs'
    },
    plugins: [
        nativePlugin({
            // Where we want to physically put the extracted .node files
            copyTo: 'dist/libs',

            // Path to the same folder, relative to the output bundle js
            destDir: './libs',

            // Use `dlopen` instead of `require`/`import`.
            // This must be set to true if using a different file extension that '.node'
            dlopen: false,

            // Modify the final filename for specific modules
            // A function that receives a full path to the original file, and returns a desired filename
            map: (modulePath) => 'filename.node',

            // OR you can have a function that returns a desired file name and a specific destination to copy to.
            map: (modulePath) => { name: 'filename.node', copyTo: 'C:\\Dist\\libs\\filename.node' },

            // A transformer function that allows replacing a given node module path with another.
            // This is good for either handling missing files, or dynamically resolving desired architectures etc.
            originTransform: (path: string, exists: boolean) => (path: string|undefined),
            
            // Generate sourcemap
            sourcemap: true,
            
            // If the target is ESM, so we can't use `require` (and .node is not supported in `import` anyway), we will need to use `createRequire` instead.
            targetEsm: false,
        })
    ]
};
```

### Using with node-pre-gyp

`node-pre-gyp` way of determining the require path is supported only if the module code matches (almost) exactly the recommended method, ie if it looks like this:
```js
const binary = require('@mapbox/node-pre-gyp');
const binding_path = binary.find(path.resolve(path.join(__dirname, '../package.json')));
const module = require(binding_path);
```

## License

MIT

## About...

This plugin was created by me and shared with you courtesy of [Silverbolt](http://silverbolt.ai/) which I'm working for.
