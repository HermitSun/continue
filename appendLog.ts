import fs from "fs";

export function appendLog(content: string): void {
  const logFilePath = "/ai4math/users/xmlu/.continue_log/log.txt";

  fs.appendFile(logFilePath, content, "utf8", (err) => {
    if (err) {
      console.error("Error appending to file:", err);
    } else {
      console.log("Content appended successfully!");
    }
  });
}
