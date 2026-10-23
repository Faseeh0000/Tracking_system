import "./env.js";
import mongoose from "mongoose";

const connectDB = async () => {
  if (!process.env.URI) {
    throw new Error("URI is not configured in .env");
  }

  try {
    await mongoose.connect(process.env.URI);
    console.log("Database is connected");
  } catch (error) {
    console.error("Database connection failed:", error.message);
    throw error;
  }
};

export default connectDB;
