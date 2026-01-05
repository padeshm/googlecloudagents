import { spawn } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";
import { RunnableConfig } from '@langchain/core/runnables';
import { CallbackManagerForToolRun } from "@langchain/core/callbacks/manager";

async function runGoogleCloudSdkCommand(
  command: string,
  runManager?: CallbackManagerForToolRun,
  config?: RunnableConfig
): Promise<string> {

  const userAccessToken = config?.configurable?.userAccessToken;
  if (!userAccessToken) {
    const errorMsg = "Authentication Error: User access token was not found.";
    console.error(errorMsg);
    return errorMsg;
  }

  const commandParts = command.trim().split(' ');
  let executable: string;
  let args: string[];

  // INTELLIGENT EXECUTION LOGIC:
  // Determine the correct executable based on the command passed by the agent.
  if (commandParts[0] === 'bq' || commandParts[0] === 'gsutil') {
    executable = commandParts[0];
    args = commandParts.slice(1);
  } else {
    // Default to gcloud for all other commands (e.g., dataplex, storage).
    executable = 'gcloud';
    args = commandParts;
  }

  const fullCommandString = `${executable} ${args.join(' ')}`;
  console.log("\n===============================================================================");
  console.log(`[SDK-TOOL] Executing command:\n${fullCommandString}`);
  console.log("===============================================================================\n");

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      env: {
        ...process.env,
        CLOUDSDK_AUTH_ACCESS_TOKEN: userAccessToken,
        CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
      },
      shell: false
    });

    let output = "";
    let error = "";
    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (error += data.toString()));

    child.on("error", (err) => {
      const spawnError = `System Error: Failed to start the command '${executable}'. Error: ${err.message}`;
      console.error(spawnError);
      resolve(spawnError);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const execError = `Execution Error (Exit Code ${code}):\n${error}`;
        resolve(execError);
      } else {
        resolve(output.trim() || stderr.trim() || "Command executed successfully.");
      }
    });
  });
}

export const googleCloudSdkTool = new DynamicTool({
  name: "google_cloud_sdk_tool",
  description: `
    Executes Google Cloud SDK commands for gcloud, bq, and gsutil.
    - For \`bq\` and \`gsutil\` commands, the input string MUST start with 'bq' or 'gsutil'. The tool will execute these commands directly.
        Example for bq: "bq show --schema --project_id=my-project-id my_dataset.my_table"
        Example for gsutil: "gsutil ls gs://my-bucket-name"
    - For \`gcloud\` commands (e.g., dataplex, compute, storage), the input string should be the command WITHOUT the 'gcloud' prefix.
        Example for gcloud: "dataplex datascans list --project=my-project-id"
  `,
  func: runGoogleCloudSdkCommand,
});
