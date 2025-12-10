import { z } from "zod";
import { spawn } from "child_process";

// Define the Input Schema
const parameters = {
  command: z.string().describe("The gcloud command arguments (e.g., 'compute instances list')"),
};

// Define the Execution Logic
const execute = async ({ command }: { command: string }) => {
  // 1. Security Filter (CRITICAL)
  const DENY_LIST = [">", "|", "&", "sudo", "rm", "delete", "create", "update"]; // Adjusted for safety
  if (DENY_LIST.some((char) => command.includes(char))) {
    return {
      content: [{ type: "text", text: "Error: Command contains forbidden characters or dangerous actions." }],
      isError: true,
    };
  }

  // 2. Execution
  const args = command.split(" ");
  return new Promise<any>((resolve) => {
    // Note: We use 'gcloud' command directly. 
    // In Cloud Run, we will ensure gcloud is in the PATH.
    const child = spawn("gcloud", args, {
      env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" },
    });

    let output = "";
    let error = "";

    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (error += data.toString()));

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          content: [{ type: "text", text: `Gcloud Error (Code ${code}): ${error}` }],
          isError: true,
        });
      } else {
        resolve({
          content: [{ type: "text", text: output }],
        });
      }
    });

    child.on("error", (err) => {
      resolve({
        content: [{ type: "text", text: `System Error: ${err.message}` }],
        isError: true,
      });
    });
  });
};

export const runGcloudCommand = {
  parameters,
  execute,
};