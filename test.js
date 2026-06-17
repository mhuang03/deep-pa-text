import { processGIFs } from "./api.js";

const content = "hahaha <gif! funny cat> <gif! that me yeah>"

const test = async () => {
  const result = await processGIFs(content);
  console.log(result);
}

test();