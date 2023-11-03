var fs = require("fs");

fs.readFile("temp.txt", "utf8", function (err, contents) {
    const i = contents.search("t=\d*");
    const temp = parseInt(contents.substring(i + 2, contents.length));
    console.log(temp / 1000);
});
