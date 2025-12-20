import mongoose from "mongoose";

const InstallationSchema = new mongoose.Schema(
  {
    teamId: { type: String, required: true, unique: true },
    enterpriseId: String,
    installation: { type: Object, required: true }, // Stores the full Slack response
  },
  { timestamps: true }
);

export const Installation = mongoose.model("Installation", InstallationSchema);
