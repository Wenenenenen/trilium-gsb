import type { Router } from "express";

import fs from "fs";
import path from "path";
import { RESOURCE_DIR } from "../services/resource_dir";
import rateLimit from "express-rate-limit";

const specPath = path.join(RESOURCE_DIR, "etapi.openapi.yaml");
let spec: string | null = null;

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
});

function register(router: Router) {
    router.get("/etapi/etapi.openapi.yaml", limiter, (_, res) => {
        if (!spec) {
            spec = fs.readFileSync(specPath, "utf8");
        }

        res.header("Content-Type", "text/plain"); // so that it displays in browser
        res.status(200).send(spec);
    });
}

export default {
    register
};
