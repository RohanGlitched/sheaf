// Starts the web app's dev server from its own folder, whatever folder launched it.
const path = require("path");
const web = path.join(__dirname, "..", "web");
const bin = path.join(web, "node_modules", "next", "dist", "bin", "next");
process.chdir(web);
process.env.WATCHPACK_POLLING = "true";
process.argv = [process.argv[0], bin, "dev", "--webpack", "--port", process.env.PORT || "3900"];
require(bin);
