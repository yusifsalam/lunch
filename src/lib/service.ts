import { db } from "@/db/db";
import { createService } from "./sessionService";

/** The app-wide service instance, bound to the real DB. */
export const service = createService(db);
