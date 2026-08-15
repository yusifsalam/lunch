import { db } from "@/db/db";
import { createService } from "./lunchService";

/** The app-wide service instance, bound to the real DB. */
export const service = createService(db);
