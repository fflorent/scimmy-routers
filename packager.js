import {promises as fs} from "fs";
import url from "url";
import path from "path";
import chalk from "chalk";
import minimist from "minimist";

// Get relative path to packager.js location from process CWD
const cwd = path.dirname(url.fileURLToPath(import.meta.url));
const basepath = path.relative(process.cwd(), cwd);

/**
 * Packager Class
 * Contains helper methods for build processes
 */
export class Packager {
    /**
     * Various paths to locations of assets used in packaging process
     * @type {{src: string, dist: string}}
     */
    static paths = {
        src: `./${path.join(basepath, "src")}`,
        dist: `./${path.join(basepath, "dist")}`
    };
    
    /**
     * Specified assets used throughout the packaging process
     * @type {{entry, chunks, externals}}
     */
    static #assets = {
        entry: "routers.js",
        externals: ["scimmy", "express", "util"]
    };
    
    /**
     * Create a step function to consistently log action's results
     * @param {Boolean} [verbose=true] - whether to show extended info about action's results
     * @returns {Function} step function
     */
    static action(verbose = true) {
        /**
         * Run a step in the build process
         * @param {String} title - headline of the step to show above actions
         * @param {Object[]} actions - list of actions to run in the step
         * @param {String} actions[].pre - text to write to console before the action is initiated
         * @param {String} actions[].post - text to write to console after the action has concluded
         * @param {Function} actions[].action - method to call to run the action and retrieve output
         * @returns {Promise<void>} promise that resolves when all actions in the step have completed
         */
        return async function step(title, actions = []) {
            // Log the step's title if being verbose
            if (verbose) console.log(chalk.bold.underline(title));
            
            // Run through each action and execute it
            for (let {pre, post, action, failure} of actions) {
                try {
                    // Log name of action, execute it, and notify on completion
                    if (!!pre) process.stdout.write(pre);
                    let result = await action();
                    if (!!pre) process.stdout.write(chalk.green("done!\r\n"));
                    
                    // Log conclusion if being verbose, and post is defined
                    if (verbose && !!post) {
                        if (typeof post === "string") console.log(post);
                        // If being verbose and there were bundles output by the action, log them
                        if (result instanceof Array) for (let bundle of result) console.log(bundle);
                        if (result instanceof Function) await result();
                    }
                } catch (ex) {
                    // Notify action failure (should only come when executing action)
                    if (!!pre) process.stdout.write(`${chalk.red("failed!")}\r\n`);
                    if (ex instanceof Function) ex();
                    else console.log(`${chalk.yellow("Reason: ")}${chalk.grey(ex.message)}\r\n`);
                    if (!!failure) console.log(chalk.red(failure));
                    process.exitCode = 1;
                    process.exit();
                }
            }
            
            // Add a newline between steps
            if (verbose) console.log("");
        }
    }
    
    /**
     * Remove a specified directory and its contents
     * @param {String} target - the directory to recursively remove
     * @returns {Promise<void>} a promise that resolves when the directory has been removed
     */
    static async clean(target) {
        try {
            return await fs.rm(target, {recursive: true});
        } catch (ex) {
            if (ex.code !== "ENOENT") throw ex;
        }
    }
    
    /**
     * Build the SCIMMY Routers library
     * @param {Boolean} [verbose=false] - whether to show extended output from each step of the build
     * @returns {Promise<void>} a promise that resolves when the build has completed
     */
    static async build(verbose = false) {
        const {src, dist: dest} = Packager.paths;
        const step = Packager.action(verbose);
        
        await step("Preparing Build Environment", [{
            pre: `Cleaning target build directory ${chalk.blue(dest)}: `,
            action: async () => await Packager.clean(dest)
        }]);
        
        await step("Preparing JavaScript bundles", [{
            pre: `Writing built bundles to ${chalk.blue(dest)}: `,
            post: "Wrote the following bundles:",
            action: async () => {
                let bundles = await Packager.rollup(src, dest, Packager.#assets);
                return bundles.map(file => `${chalk.grey(dest)}/${file}`);
            }
        }]);
        
        await step("Preparing TypeScript definitions", [{
            pre: `Writing definitions to ${chalk.blue(dest)}/${chalk.magenta(Packager.#assets.entry.replace(".js", ".d.ts"))}: `,
            post: "Generated type definitions from the following files:",
            action: async () => {
                const dtsName = Packager.#assets.entry.replace(".js", ".d.ts");
                const dtsPath = `${dest}/${dtsName}`;
                const bundles = await Packager.typedefs(`${src}/${Packager.#assets.entry}`, dtsPath);
                const dtsSrc = String(await fs.readFile(`${src}/${dtsName}`, "utf8"));
                const dtsDest = String(await fs.readFile(dtsPath, "utf8"))
                    // Strip irrelevant module declarations from generated .d.ts file
                    .match(/declare module "routers" \{\n(.*)}/s).pop();
                
                await fs.writeFile(dtsPath, dtsSrc
                    // Strip irrelevant parts of .d.ts file...
                    .slice(dtsSrc.indexOf('declare module "scimmy-routers"'))
                    // ...and insert generated definitions
                    .replace(/(})$/s, `${dtsDest}$1`));
                
                return bundles.map(file => file.replace(src, chalk.grey(src)));
            }
        }]);
    }
    
    /**
     * Use RollupJS to bundle sources into defined packages
     * @param {String} src - the source directory to read assets from
     * @param {String} dest - the destination directory to write bundles to
     * @param {Object} assets - entry-point and chunk files to pass to RollupJS
     * @param {String} assets.entry - entry point for RollupJS
     * @param {String[]} assets.externals - imports that are used but not local for RollupJS
     * @param {Object} assets.chunks - chunk file definitions for RollupJS
     * @returns {Promise<String[]>} names of files generated by RollupJS
     */
    static async rollup(src, dest, assets) {
        const rollup = await import("rollup");
        const {entry: input, chunks, externals} = assets;
        const fileNameConfig = {esm: "[name].js", cjs: "[name].cjs"};
        const output = [];
        const config = {
            dir: dest,
            exports: "named",
            manualChunks: chunks,
            minifyInternalExports: false,
            hoistTransitiveImports: false,
            generatedCode: {
                constBindings: true
            }
        };
        
        // Prepare RollupJS bundle with supplied entry point
        let bundle = await rollup.rollup({
            input: path.join(src, input), external: externals,
            onwarn: (warning, warn) => (warning.code !== "CIRCULAR_DEPENDENCY" ? warn(warning) : false)
        });
        
        // Construct the bundles with specified chunks in specified formats and write to destination
        for (let format of ["esm", "cjs"]) {
            let {output: results} = await bundle.write({
                ...config, format: format, entryFileNames: fileNameConfig[format], chunkFileNames: fileNameConfig[format]
            });
            
            output.push(...results.map(file => file.fileName));
        }
        
        return output;
    }
    
    /**
     * Use TypeScript Compiler API to generate type definitions
     * @param {String} src - the source directory to read assets from
     * @param {String} dest - the destination file or directory to write compiled output to
     * @returns {Promise<String[]>} names of files with generated types
     */
    static async typedefs(src, dest) {
        // Prepare a TypeScript Compiler Program for compilation
        const {default: ts} = await import("typescript");
        const program = ts.createProgram(Array.isArray(src) ? src : [src], {
            allowJs: true, declaration: true, emitDeclarationOnly: true,
            // If destination is a TypeScript or JavaScript file, assume all sources are targeting a single file
            ...(dest.endsWith(".ts") || dest.endsWith(".js") ? {outFile: dest} : {outDir: dest})
        });
        
        // Run the compiler instance
        program.emit();
        
        // Go through and get the results of which source files were read by the compiler
        let output = [];
        for (let sourceFile of program.getSourceFiles()) {
            if (!sourceFile.isDeclarationFile) {
                // Make sure the source file wasn't a TypeScript Library, then add the relative path to results
                let fileName = sourceFile.fileName.replace(`${cwd}${path.sep}`, "./");
                output.push(fileName.startsWith("./") ? fileName : `./${fileName}`);
            }
        }
        
        return output;
    }
}

if (process.argv[1] === url.fileURLToPath(import.meta.url)) {
    const config = minimist(process.argv, {alias: {t: "target"}});
    
    switch (config.target) {
        case "clean":
            await Packager.action()("Cleaning Build Directory", [
                {pre: "Cleaning build directory: ", action: async () => await Packager.clean(Packager.paths.dist)}
            ]);
            break;
        
        case "build":
            await Packager.build(true);
            break;
            
        case "prepack":
            await Packager.build(false);
            break;
        
        case "lint":
            break;
        
        case "test":
            break;
            
        default:
            console.log("No target specified.");
    }
}