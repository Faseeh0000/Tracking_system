import express from "express";
import { GetShipment, GetShipments } from "../services/trackingService.js";

const router = express.Router();

router.post("/tracking", GetShipment);
router.post("/tracking/arr", GetShipments);
export default router;
