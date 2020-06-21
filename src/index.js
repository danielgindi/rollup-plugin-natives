const Path = require('path');
const Fs = require('fs');

function nativePlugin(options) {

    let copyTo = options.copyTo || './';
    let destDir = options.destDir || './';
    let dlopen = options.dlopen || false;
    let map = options.map;

    if (typeof map !== 'function') {
        map = fullPath => generateDefaultMapping(fullPath);
    }

    const PREFIX = '\0natives:';

    try {
        Fs.mkdirSync(copyTo);
    } catch {}

    let renamedMap = /**@type {Map<String, {name: String, copyTo: String}>}*/new Map();

    function exportModule(path) {
        if (dlopen)
            return `
            function get() {
              let p = require('path').resolve(__dirname, ${JSON.stringify(path)});
              if (!require.cache[p]) {
                let module = {exports:{}};
                process.dlopen(module, p);
                require.cache[p] = module;
              }
              // Fool other plugins, leave this one alone! (Resilient to uglifying too)
              let req = require || require;
              return req(p);
            };
            export default get();\n`;

        return `export default require(${JSON.stringify(path)});\n`;
    }

    function findAvailableBasename(path) {
        let basename = Path.basename(path);

        let i = 1;
        while (Array.from(renamedMap.values()).filter(x => x.name === rebaseModule(basename)).length) {
            basename = Path.basename(path, Path.extname(path)) + '_' + (i++) + Path.extname(path);
        }

        return basename;
    }

    function rebaseModule(basename) {
        return (destDir + (/\\$|\/$/.test(destDir) ? '' : '/') + basename).replace(/\\/g, '/');
    }

    function generateDefaultMapping(path) {
        let basename = findAvailableBasename(path);

        return {
            name: rebaseModule(basename),
            copyTo: Path.join(copyTo, basename),
        };
    }

    return {
        name: 'rollup-plugin-natives',

        load(id) {
            if (id.startsWith(PREFIX))
                return exportModule(id.substr(PREFIX.length));

            if (renamedMap.has(id))
                return exportModule(renamedMap.get(id).name);

            return null;
        },

        transform(source, id) {
            let code = source.replace(/require\(['"]bindings['"]\)\(((['"]).+?\2)?\)/g, (match, name) => {
                let nativeAlias = name ? new Function('return ' + name)() : 'bindings.node';
                if (!nativeAlias.endsWith('.node'))
                    nativeAlias += '.node';

                let moduleRoot = Path.dirname(id), prev = null;
                while (true) {
                    if (moduleRoot === '.')
                        moduleRoot = process.cwd();

                    if (Fs.existsSync(Path.join(moduleRoot, 'package.json')) || Fs.existsSync(Path.join(moduleRoot, 'node_modules')))
                        break;

                    if (prev === moduleRoot)
                        break;

                    // Try the parent dir next
                    prev = moduleRoot;
                    moduleRoot = Path.resolve(moduleRoot, '..');
                }

                let partsMap = {
                    'compiled': process.env.NODE_BINDINGS_COMPILED_DIR || 'compiled'
                    , 'platform': process.platform
                    , 'arch': process.arch
                    , 'version': process.versions.node
                    , 'bindings': nativeAlias
                    , 'module_root': moduleRoot
                };

                let possibilities = [
                    ['module_root', 'build', 'bindings']
                    , ['module_root', 'build', 'Debug', 'bindings']
                    , ['module_root', 'build', 'Release', 'bindings']
                    , ['module_root', 'compiled', 'version', 'platform', 'arch', 'bindings']
                ];

                let possiblePaths = /**@type {String[]}*/possibilities.map(parts => {
                    parts = parts.map(part => {
                        if (partsMap.hasOwnProperty(part))
                            return partsMap[part];
                        return part;
                    });
                    return Path.join.apply(Path, parts);
                });

                let chosenPath = possiblePaths.filter(x => Fs.existsSync(x))[0] || possiblePaths[0];

                return "require(" + JSON.stringify(chosenPath.replace(/\\/g, '/')) + ")";
            });

            if (code.indexOf('node-pre-gyp') !== -1) {
                code = source.replace(/(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+binary\.find\(path\.resolve\(path\.join\(__dirname,\s*((['"]).*\4)\)\)\);?\s*(var|let|const)\s+([a-zA-Z0-9_]+)\s+=\s+require\(\2\)/g, (match, d1, v1, ref, p, d2, v2) => {
                    let preGyp = null;

                    try {
                        // noinspection NpmUsedModulesInstalled
                        preGyp = require('node-pre-gyp')
                    } catch (ex) {
                        return match;
                    }

                    let libPath = preGyp.find(Path.resolve(Path.join(Path.dirname(id), new Function('return ' + ref)())));

                    return `${d1} ${v1}=${JSON.stringify(libPath.replace(/\\/g, '/'))};${d2} ${v2}=require(${JSON.stringify(libPath.replace(/\\/g, '/'))})`;
                });
            }

            return code;
        },

        resolveId(importee, importer) {
            if (importee.startsWith(PREFIX))
                return importee;

            // Avoid trouble with other plugins like commonjs
            if (importer && importer[0] === '\0' && importer.indexOf(':') !== -1)
                importer = importer.slice(importer.indexOf(':') + 1);
            if (importee && importee[0] === '\0' && importee.indexOf(':') !== -1)
                importee = importee.slice(importee.indexOf(':') + 1);

            let resolvedFull = Path.resolve(importer ? Path.dirname(importer) : '', importee);

            let nativePath = null;
            if (/\.(node|dll)$/i.test(importee))
                nativePath = resolvedFull;
            else if (Fs.existsSync(resolvedFull + '.node'))
                nativePath = resolvedFull + '.node';
            else if (Fs.existsSync(resolvedFull + '.dll'))
                nativePath = resolvedFull + '.dll';

            if (nativePath) {
                let mapping = renamedMap.get(nativePath), isNew = false;

                if (!mapping) {
                    mapping = map(nativePath);

                    if (typeof mapping === 'string') {
                        mapping = generateDefaultMapping(mapping);
                    }

                    renamedMap.set(nativePath, mapping);
                    isNew = true;
                }

                if (isNew) {
                    Fs.copyFileSync(nativePath, mapping.copyTo);
                }

                return PREFIX + mapping.name;
            }

            return null;
        }
    };
}

module.exports = nativePlugin;
