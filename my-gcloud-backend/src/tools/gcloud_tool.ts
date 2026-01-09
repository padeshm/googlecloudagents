/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *	http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Tool } from "@langchain/core/tools";
import * as child_process from 'child_process';
import {
  AccessControlList,
  createAccessControlList,
} from '../denylist';
import * as gcloud from '../gcloud';
import type { RunnableConfig } from "@langchain/core/runnables";
import type { CallbackManagerForToolRun } from "@langchain/core/callbacks/manager";


// Denylist any command that is interactive or requires a TTY.
// These commands will hang the process.
const defaultDeny = [
  'sftp',
  'ssh',
  'docker', // Requires configuring docker-credential-gcr.
  'gen-repo-info-file',
];

const accessControl = createAccessControlList([], defaultDeny);

class GoogleCloudSDK extends Tool {
    name = 'google-cloud-sdk';
    description = `Executes a command for a Google Cloud command-line interface: gcloud, gsutil, kubectl, or bq. Input should be the full command string.`;

    async _call(
      commandString: string,
      runManager?: CallbackManagerForToolRun,
      config?: RunnableConfig
    ): Promise<string> {

      const allArgs = commandString.trim().split(' ');
      const tool = allArgs[0];
      const args = allArgs.slice(1);

      if (!["gcloud", "gsutil", "kubectl", "bq"].includes(tool)) {
        return `Error: Invalid tool '${tool}'. The first word of the command must be one of gcloud, gsutil, kubectl, or bq.`;
      }

      const userAccessToken = config?.configurable?.userAccessToken;
      // Added for diagnostics
      console.log(`[GCLOUD_TOOL] Received userAccessToken: ${userAccessToken ? 'Exists' : 'Not Found'}`)

      const accessControlResult = accessControl.check(args.join(' '));
      if (accessControlResult.permitted === false) {
        return accessControlResult.message;
      }
    
      const gcloudResult = await gcloud.lint(args.join(' '));
      if (gcloudResult.success === false) {
        return gcloudResult.error;
      }
      const cleanArgs = gcloudResult.parsedCommand.split(' ');
    
      const command = {
        tool: tool,
        args: cleanArgs,
      };
    
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        const env = { ...process.env };
        if (userAccessToken) {
            // Added for diagnostics
            console.log('[GCLOUD_TOOL] Setting CLOUDSDK_AUTH_ACCESS_TOKEN in environment.');
            env['CLOUDSDK_AUTH_ACCESS_TOKEN'] = userAccessToken;
        }

        // ** THE DEFINITIVE FIX **
        // Force gcloud to use the project specified in the command, overriding any environment defaults.
        const projectIndex = command.args.findIndex(arg => arg === '--project');
        if (projectIndex !== -1 && projectIndex + 1 < command.args.length) {
            const projectId = command.args[projectIndex + 1];
            console.log(`[GCLOUD_TOOL] Found --project flag. Forcing CLOUDSDK_CORE_PROJECT to: ${projectId}`);
            env['CLOUDSDK_CORE_PROJECT'] = projectId;
        }

        const child = child_process.spawn(command.tool, command.args, {
          env,
        });
    
        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
    
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });
    
        child.on('close', (code) => {
          // Enhanced logging for diagnostics
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] Command: '${command.tool} ${command.args.join(' ')}'`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] Exit Code: ${code}`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] STDOUT: ${stdout}`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] STDERR: ${stderr}`);

          if (code === 0) {
            if (stdout.trim() === '') {
                resolve("Command executed successfully and returned no output.");
            } else {
                resolve(stdout);
            }
          } else {
            // Return the full STDERR on failure.
            resolve(`Error: Command failed with exit code ${code}. Stderr: ${stderr}`);
          }
        });
    
        // Handle errors where the process itself fails to start.
        child.on('error', (err) => {
          resolve(`Failed to start the ${command.tool} process: ${err.message}`);
        });
      });
    }
}

export const googleCloudSdkTool = new GoogleCloudSDK();
