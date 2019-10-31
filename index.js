const fs = require("fs");
const zlib = require('zlib');
let serveStatic = require('serve-static');
let sanitizeOptions = require('./util/options').sanitizeOptions;
let findEncoding = require('./util/encoding-selection').findEncoding;
let mime = serveStatic.mime;

module.exports = expressStaticGzipMiddleware;

/**
 * Generates a middleware function to serve pre-compressed files. It is build on top of serveStatic.
 * The pre-compressed files need to be placed next to the original files, in the provided `root` directory.
 * @param { string } root: directory to staticly serve files from
 * @param { expressStaticGzip.ExpressStaticGzipOptions } options: options to change module behaviour  
 * @returns express middleware function
 */
function expressStaticGzipMiddleware(root, options) {
    let opts = sanitizeOptions(options);
    let serveStaticMiddleware = serveStatic(root, opts.serveStatic || null);
    let compressions = [];
    let files = {};

    registerCompressionsFromOptions();
    parseRootDirForCompressedFiles();
    
    return expressStaticGzip;

    function expressStaticGzip(req, res, next) {
        changeUrlFromDirectoryToIndexFile(req);

        var clientsAcceptedEncodings = req.headers["accept-encoding"];

        req.path = req.url;

        var fileWithMatchingPath = files[decodeURIComponent(req.path.split('?')[0])];
        if (fileWithMatchingPath) {
            // The Vary Header is required for caching proxies to work properly
            res.setHeader("Vary", "Accept-Encoding");

            let compression;
            if(clientsAcceptedEncodings.indexOf('br')) compression = compressions[0];
            if(clientsAcceptedEncodings.indexOf('gzip')) compression = compressions[1];

            //var compression = findEncoding(clientsAcceptedEncodings, fileWithMatchingPath.compressions, opts.orderPreference);
            if (compression) {
                convertToCompressedRequest(req, res, compression);
            }
        }
        else console.log(req.url);

        serveStaticMiddleware(req, res, next);
    }

    function registerCompressionsFromOptions() {
        registerCompression("br", "br");
        registerCompression("gzip", "gz");

        if (opts.customCompressions && opts.customCompressions.length > 0) {
            for (var i = 0; i < opts.customCompressions.length; i++) {
                var customCompression = opts.customCompressions[i];
                registerCompression(customCompression.encodingName, customCompression.fileExtension);
            }
        }
    }

    function convertToCompressedRequest(req, res, compression) {
        var type = mime.lookup(req.path);
        var charset = mime.charsets.lookup(type);
        var search = req.url.split('?').splice(1).join('?');

        if (search !== "") {
            search = "?" + search;
        }

        req.url = req.path + compression.fileExtension + search;
        res.setHeader("Content-Encoding", compression.encodingName);
        res.setHeader("Content-Type", type + (charset ? "; charset=" + charset : ""));
    }

    function changeUrlFromDirectoryToIndexFile(req) {
        if (opts.index && req.url.endsWith("/")) {
            req.url += opts.index;
        }
    }
    
    function parseRootDirForCompressedFiles() {
        if (compressions.length > 0) {
            findCompressedFilesInDirectory(root);
        }
    }

    function findCompressedFilesInDirectory(directoryPath) {
        if (!fs.existsSync(directoryPath))  return; 
        
        var filesInDirectory = fs.readdirSync(directoryPath);
        for (var i = 0; i < filesInDirectory.length; i++) {
            var filePath = directoryPath + "/" + filesInDirectory[i];
            var stats = fs.statSync(filePath);
            if (stats.isDirectory()) {
                findCompressedFilesInDirectory(filePath);
            } else {
                addMatchingCompressionsToFile(filesInDirectory[i], filePath);
            }
        }
    }

    /**
     * Takes a filename and checks if there is any compression type matching the file extension.
     * Adds all matching compressions to the file.     
     * @param {string} fileName
     * @param {string} fillFilePath
     */
    function addMatchingCompressionsToFile(fileName, fullFilePath) {
        for (var i = 0; i < compressions.length; i++) {
            if (fileName.endsWith(compressions[i].fileExtension)) {
                addCompressionToFile(fullFilePath, compressions[i]);
                return;
            }
        }

        /*
            Attempt to compress files that are not compressed or that have not failed to be compressed.
        */

       makeCompressedFiles(fullFilePath,(err,f,c)=>
       {
            if(err)
            {
                console.log(`Error while trying to compress ${f}`,err);
                return;
            }
            addCompressionToFile(f, c);
       })
    }

    async function makeCompressedFiles(f,e)
    {
        if(f.endsWith('.nz') || f.endsWith('.gz') || f.endsWith('.br'))
            return;
            
        const src = `${f}`, nzn = `${f}.nz`, gzn = `${f}.gz`, brn = `${f}.br`;

        if(fs.existsSync(brn))
            e(null,brn,compressions[0])

        if(fs.existsSync(gzn))
            e(null,gzn,compressions[1])

        if(fs.existsSync(nzn))
            return;

        fs.closeSync(fs.openSync(nzn, 'w'));
        const tsz = fs.statSync(src).size;

        const was_effective = (err,n,c) =>
        {
            if(err) e(err,n,c);
            else if(fs.statSync(n).size > tsz)
            {
                fs.unlinkSync(n);
                e("Compression Not Effective",n,c);
            }
            else e(null,n,c);
        };

        const fileContents = fs.createReadStream(src);

        fileContents.pipe(zlib.createGzip()).pipe(fs.createWriteStream(gzn)).on('finish', (err) => was_effective(err,gzn,compressions[1]));
        fileContents.pipe(zlib.createBrotliCompress()).pipe(fs.createWriteStream(brn)).on('finish', (err) => was_effective(err,brn,compressions[0]));
    }

    /**
     * Adds the compression to the file's list of available compressions
     * @param {string} filePath
     * @param {Compression} compression
     */
    function addCompressionToFile(filePath, compression) {
        var srcFilePath = filePath.replace(root, "").replace(compression.fileExtension, "");
        var existingFile = files[srcFilePath];
        if (!existingFile) {
            files[srcFilePath] = { compressions: [compression] };
        } else {
            existingFile.compressions.push(compression);
        }
    }

    /**
     * Registers a new compression to the module.
     * @param {string} encodingName
     * @param {string} fileExtension
     */
    function registerCompression(encodingName, fileExtension) {
        if (!findCompressionByName(encodingName)) {
            compressions.push(new Compression(encodingName, fileExtension));
        }
    }

    /**
     * @param {string} encodingName
     * @param {string} fileExtension
     * @returns {{encodingName:string, fileExtension:string}}
     */
    function Compression(encodingName, fileExtension) {
        this.encodingName = encodingName;
        this.fileExtension = "." + fileExtension;
    }

    /**
     * @param {string} encodingName
     * @returns {{encodingName:string, fileExtension:string}}
     */
    function findCompressionByName(encodingName) {
        for (var i = 0; i < compressions.length; i++) {
            if (compressions[i].encodingName === encodingName) {
                return compressions[i];
            }
        }

        return null;
    }
}
