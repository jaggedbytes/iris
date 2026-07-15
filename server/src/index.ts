import "dotenv/config";

import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3001);

app.listen(port, () => {
  console.log(`Iris server listening on http://localhost:${port}`);
});
