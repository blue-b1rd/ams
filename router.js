const fs = require("fs"),
      path = require("path"),
      pug = require("pug"),
      xss = require("xss"),
      ini = require("ini");

module.exports = {
    prepare: function (callback) {
        reloadConfigurations();
        return rebootProcessors(function (booted) {
            reloadMIMEs();
            callback(booted);
        });
    },
    route: route,
    bleed: bleed,
    stream: stream,
    reloadMIMEs: reloadMIMEs,
    rebootProcessors: rebootProcessors,
    resetPrecompiledPugs: resetPrecompiledPugs,
    resetCachedRenderedPages: resetCachedRenderedPages,
    reloadConfigurations: reloadConfigurations,
    downloadClientPostData: downloadClientPostData
};

const security = require("./security");

const responseErrorMessages = {
    306: ["Unknown error", "Something wrong happened, but we do not know what exactly it was."],

    400: ["Bad Request", "It's not our fault: your browser did not deliver correct data."],
    401: ["Unauthorized", "You are not authorized to view this content."],
    403: ["Forbidden", "You are not permitted to view this content."],
    404: ["File not found", "Oh, no! Space invaders destroyed this page! Take revenge of them!"],
    500: ["Internal Server Error", "Something went wrong. We will fix it, we promise."],
    503: ["Service Unavailable", "Seems to be server is broken. It will be cured, but actually we do not know when!"]
};

let supportedFileTypes = {};
let pageProcessors = {};
let precompiledPugPages = {};
let cachedRenderedPages = {};
let pugCompilerOptions = {
    pretty: false
};

let renderTimeout = 5000;
let bleedStacktraceAllowed = false;
let currentTemplateName = "test";

const  PATHS_templateDir = path.join(__dirname, "templates", currentTemplateName),
       PATHS_templateResourcesDir = path.join(PATHS_templateDir, "resources"),
       PATHS_templateSheathDir = path.join(PATHS_templateDir, "sheath"),
       PATHS_templatePreprocessorsDir = path.join(PATHS_templateDir, "processors"),
       PATHS_dataDir = path.join(__dirname, "data"),
       PATHS_dataPublicDir = path.join(PATHS_dataDir, "public"),
       PATHS_dataPrivateDir = path.join(PATHS_dataDir, "private");

function reloadMIMEs() {
    const oldSupportedFileTypes = supportedFileTypes;
    try {
        supportedFileTypes = JSON.parse(fs.readFileSync(path.join(__dirname, "configurations", "mimeTypes.json"), "utf-8"));
    } catch (e) {
        console.error("An error occurred while reloading MIME types from disk. Changes reverted!");
        supportedFileTypes = oldSupportedFileTypes;
    }
}

function rebootProcessors(callback) {
    let newPageProcessors = [];
    fs.readdir(PATHS_templatePreprocessorsDir, function (err, filesList) {
        let booted = 0;
        let stat;
        let fileFullPath;
        filesList.forEach(function (fileName) {
            fileFullPath = path.join(PATHS_templatePreprocessorsDir, fileName);
            stat = fs.statSync(fileFullPath);
            if (stat.isFile()) {
                try {
                    newPageProcessors.push(require(fileFullPath));
                    console.log("Booted processor " + fileName);
                } catch (e) {
                    console.error("Can't boot \"" + fileName + "\" processor!", e);
                }
            }
            if (++booted === filesList.length) {
                pageProcessors = newPageProcessors;
                callback(booted);
            }
        });
    });
}

function route(request, response) {
    try {
        let matchedProcessor = null;
        const requestedURL = decodeURI(request.url);

        console.log("Requested page ", requestedURL);

        if (request.method === "GET" && typeof cachedRenderedPages[requestedURL] !== "undefined" && cachedRenderedPages[requestedURL][0] > (new Date().getTime())) {
            console.log("Using page from cache");
            response.writeHead(200, cachedRenderedPages[requestedURL][2]);
            response.write(cachedRenderedPages[requestedURL][1], "utf-8");
            return response.end();
        }

        let i = 0;
        while (!matchedProcessor && i < pageProcessors.length) {
            const routeCondition = pageProcessors[i].path;
            if (!matchedProcessor && routeCondition.test(requestedURL)) {
                matchedProcessor = pageProcessors[i].processor;
            }
            i++;
        }
        if (matchedProcessor) {
            return render(matchedProcessor, requestedURL, request, response);
        }

        let stat;

        const filePathInTemplateResources = path.join(PATHS_templateResourcesDir, requestedURL);
        if (fs.existsSync(filePathInTemplateResources)) { // TODO: filesystem vulnarability! - non restricted access to nearby hidden-files
            stat = fs.statSync(filePathInTemplateResources);
            if (stat.isFile()) {
                return stream(filePathInTemplateResources, stat, request, response);
            } else {
                return bleed(403, requestedURL, response);
            }
        }

        const filePathInData = path.join(PATHS_dataPublicDir, requestedURL);
        if (fs.existsSync(filePathInData)) {
            stat = fs.statSync(filePathInData);
            if (stat.isFile()) {
                return stream(filePathInData, stat, request, response);
            } else {
                return bleed(403, requestedURL, response);
            }
        }

        bleed(404, requestedURL, response);
    } catch (e) {
        bleed(500, null, response, e);
        console.error("An error occurred in router -> route", e);
    }
}

function bleed(errorCode, retrievedAddress, response, error) {

    if (response.finished) return;

    if (errorCode === 301 || errorCode === 302) {
        console.log("Redirecting " + errorCode + " to " + retrievedAddress);
        response.writeHead(errorCode, {
            "Cache-Control": "no-cache",
            "Location": retrievedAddress
        });
        response.end();
        return;
    }

    console.warn("Bleeding an error", errorCode);
    if (typeof responseErrorMessages[errorCode] !== "object") {
        console.error("Unknown error code " + errorCode + " used!");
        errorCode = 306;
    }

    // Prepare data for bleed
    const errorMessage = responseErrorMessages[errorCode],
          timestamp = new Date().toString();

    // Search for custom error template
    const sheathName = "$httpErr" + errorCode,
          sheathPath = path.join(PATHS_templateSheathDir, "errors", errorCode + ".pug");
    let errorTrace;
    if (typeof error !== "undefined" && error !== null && bleedStacktraceAllowed){
        if (typeof error.stack !== "undefined") {
            errorTrace = error.stack;
        } else if (typeof error.message !== "undefined") {
            errorTrace = error.message;
        } else {
            errorTrace = "Unknown error: can't be parsed\nSeems to be developer's code makes bleed with incorrect Error-object";
        }
    } else {
        errorTrace = null;
    }
    let responseData;
    if (fs.existsSync(sheathPath)) {
        if (typeof precompiledPugPages[sheathName] === "undefined") {
            precompiledPugPages[sheathName] = pug.compileFile(sheathPath, pugCompilerOptions);
        }
        responseData = precompiledPugPages[sheathName]({
            code: errorCode,
            title: errorMessage[0],
            description: errorMessage[1],
            timestamp: timestamp,
            url: typeof retrievedAddress === "string" ? retrievedAddress : null,
            stacktrace: errorTrace
        });
    } else {
        responseData = "<h1>" + errorCode + " " + errorMessage[0] + "</h1>" + errorMessage[1] + "<br/><br/><i>AMS Portal Framework @ 2018, by iLeonidze, Swenkal, Spartedo</i>";
        if (typeof retrievedAddress === "string" && retrievedAddress !== null) responseData += "<br/><i>Requested address: " + xss(retrievedAddress) + "</i>";
        responseData += "<br/><i>Time: " + timestamp + "</i>";
        if (errorTrace !== null) {
            responseData += "<br/><br/><p style='color:red;font-family: Consolas, sans-serif;'>Error: " + errorTrace.replace(/\n/g, "<br/>") + "</p>";
        }
    }

    response.writeHead(errorCode, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/html; charset=utf-8",
        "Content-Size": responseData.length
    });
    response.write(responseData, "utf-8");
    return response.end();
}

function stream(filePath, fileStatistics, request, response) {
    console.log("Streaming file", filePath);

    const requestPathElements = request.url.split("."),
          fileExtension = requestPathElements[requestPathElements.length - 1].toLowerCase();
    let contentType;
    if (typeof supportedFileTypes[fileExtension] === "string") {
        contentType = supportedFileTypes[fileExtension];
    }
    if (contentType == null) {
        contentType = "application/octet-stream"
    }
    console.log("Desired content type: ", contentType);
    response.writeHead(200, { // TODO: some client caching policies for specific filetypes
        "Content-Type": contentType,
        "Content-Length": fileStatistics.size
    });

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(response);
}

function render(pageProcessor, requestedURL, request, response) {
    try {
        let timeoutBleeded = false;
        const processorTimeout = setTimeout(function () {
            if (!response.finished) bleed(503, null, response, new Error("Processor reached timeout"));
        }, renderTimeout);
        return security.getSessionFromRequest(request, response, function (sessionToken, sessionData) {
            pageProcessor(request, response, function (processedData, useSheathName, serverCacheTime, clientCacheTime, contentType) {
                if (!timeoutBleeded) {
                    clearTimeout(processorTimeout);
                    if (!response.finished && typeof processedData !== "undefined" && processedData !== null) {
                        try {
                            let responseData;
                            if (typeof serverCacheTime !== "number" || serverCacheTime == null || !serverCacheTime) {
                                serverCacheTime = 0;
                            }
                            if (typeof clientCacheTime === "undefined" || clientCacheTime == null || !clientCacheTime) {
                                clientCacheTime = "no-cache";
                            } else {
                                clientCacheTime = "max-age=" + clientCacheTime
                            }
                            if (useSheathName) {
                                contentType = "text/html; charset=utf-8";
                                if (typeof useSheathName !== "string") {
                                    throw new Error("Incorrect sheath variable type used! Can be only String.");
                                }
                                if (typeof precompiledPugPages[useSheathName] === "undefined") {
                                    precompiledPugPages[useSheathName] = pug.compileFile(path.join(PATHS_templateSheathDir, useSheathName + ".pug"), pugCompilerOptions);
                                }
                                responseData = precompiledPugPages[useSheathName](processedData);
                            } else {
                                if (typeof contentType === "undefined" || contentType == null) {
                                    contentType = "text/plain; charset=utf-8";
                                }
                                responseData = processedData;
                            }
                            let head = {
                                "Cache-Control": clientCacheTime,
                                "Content-Type": contentType,
                                "Content-Length": responseData.length
                            };
                            response.writeHead(200, head);
                            response.write(responseData);
                            response.end();
                            if (request.method === "GET" && serverCacheTime > 0) cachedRenderedPages[requestedURL] = [new Date().getTime() + (serverCacheTime * 1000), responseData, head];
                        } catch (e) {
                            bleed(500, null, response, e);
                            console.error("An error occurred in router -> renderer (after processor)", e);
                        }
                    }
                }
            }, sessionData, sessionToken);
        });
    } catch (e) {
        bleed(500, null, response, e);
        console.error("An error occurred in router -> renderer (on processor)", e);
    }
}

function resetPrecompiledPugs() {
    precompiledPugPages = {};
}

function resetCachedRenderedPages() {
    cachedRenderedPages = {};
}

function reloadConfigurations() {

    currentTemplateName = fs.readFileSync(path.join(__dirname, "configurations", "template.txt"), "utf-8");
    console.log("Configs, current template:\t\t", currentTemplateName);
    const routerConfigurations = ini.parse(fs.readFileSync(path.join(__dirname, "configurations", "router.ini"), "utf-8"));

    // PUG
    pugCompilerOptions.pretty = routerConfigurations["pug"]["pretty"];
    console.log("Configs, pug pretty html:\t\t", pugCompilerOptions.pretty);

    // ROUTER
    renderTimeout = routerConfigurations["main"]["renderTimeout"];
    console.log("Configs, rendering timeout:\t\t", renderTimeout);
    bleedStacktraceAllowed = routerConfigurations["bleed"]["printStacktrace"];
    console.log("Configs, on bleed print stack:\t", bleedStacktraceAllowed);

}

function downloadClientPostData(request, callback, awaitingDataLength) {
    if (typeof awaitingDataLength !== "number") {
        // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
        awaitingDataLength = 1e6;
    }
  let body = Buffer.from("");
    request.on("data", function (data) {
        body = Buffer.concat([body, data]);
        if (body.length > awaitingDataLength) { // Too much POST data, kill the connection!
            console.warn("User retrieved too much data - destroying connection!");
            request.connection.destroy();
        }
    });
    request.on("error", function (e) {
        callback(e, body.toString());
    });
    request.on("end", function () {
        callback(null, body.toString());
    });
}
