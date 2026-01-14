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

let lastKnownProjectId = ''; // Add stateful variable for project ID

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
      // BUILD_MARKER: V18 - Smart Parser for bq query
      console.log(`[GCLOUD_TOOL_LOG] Raw command string from agent: "${commandString}"`);

      let tool: string;
      let args: string[];

      // The simple .split(' ') is not robust enough for commands that contain
      // quoted arguments with spaces, like `bq query 'SELECT ...'`.
      // We need to special-case `bq query` to handle this.
      if (commandString.startsWith('bq query')) {
        console.log('[GCLOUD_TOOL] bq query detected. Using smart parser.');
        const sqlQueryIndex = commandString.indexOf("'");
        if (sqlQueryIndex === -1) {
          // Fallback for malformed bq query command without single quotes
          [tool, ...args] = commandString.trim().split(' ');
        } else {
          const preQueryString = commandString.substring(0, sqlQueryIndex).trim();
          // The SQL query is the rest of the string, preserving quotes.
          const sqlQuery = commandString.substring(sqlQueryIndex);
          
          const preQueryArgs = preQueryString.split(' ').filter(arg => arg.length > 0);
          tool = preQueryArgs[0];
          args = [...preQueryArgs.slice(1), sqlQuery];
        }
      } else {
        // For all other commands, the simple split is sufficient.
        [tool, ...args] = commandString.trim().split(' ');
      }

      if (!["gcloud", "gsutil", "kubectl", "bq"].includes(tool)) {
        return `Error: Invalid tool '${tool}'. The first word of the command must be one of gcloud, gsutil, kubectl, or bq.`;
      }

      const userAccessToken = config?.configurable?.userAccessToken;
      const env = { ...process.env };
      
      const isSignUrlCommand = commandString.includes('gcloud storage sign-url');

      // Logic to handle impersonation context
      if (isSignUrlCommand) {
        console.log('[GCLOUD_TOOL] Impersonation bypassed for sign-url. Using application default credentials.');
      } 
      else if (userAccessToken) {
        console.log('[GCLOUD_TOOL] Impersonation active: Setting CLOUDSDK_AUTH_ACCESS_TOKEN in environment.');
        env['CLOUDSDK_AUTH_ACCESS_TOKEN'] = userAccessToken;
      }

      // Find the project ID from command flags.
      let projectId = '';
      const projectIndex = args.findIndex(arg => arg === '--project');
      const pIndex = args.findIndex(arg => arg === '-p');
      const bqIndex = args.findIndex(arg => arg.startsWith('--project_id'));

      if (projectIndex !== -1 && projectIndex + 1 < args.length) {
          projectId = args[projectIndex + 1];
          console.log(`[GCLOUD_TOOL] Found --project flag. Using project: ${projectId}`);
      } else if (pIndex !== -1 && pIndex + 1 < args.length) {
          projectId = args[pIndex + 1];
          console.log(`[GCLOUD_TOOL] Found -p flag. Using project: ${projectId}`);
      } else if (bqIndex !== -1) {
          const bqArg = args[bqIndex];
          if (bqArg.includes('=')) {
              projectId = bqArg.split('=')[1];
          } else if (bqIndex + 1 < args.length) {
              projectId = args[bqIndex + 1];
          }
          if(projectId) {
              console.log(`[GCLOUD_TOOL] Found --project_id flag. Using project: ${projectId}`);
          }
      }

      // Stateful Project Context
      if (projectId) {
        console.log(`[GCLOUD_TOOL] Forcing CLOUDSDK_CORE_PROJECT to: ${projectId}`);
        env['CLOUDSDK_CORE_PROJECT'] = projectId;
        lastKnownProjectId = projectId; // Remember the project for subsequent calls
      } else if (lastKnownProjectId) {
        console.log(`[GCLOUD_TOOL] No project flag in command, using last known project: ${lastKnownProjectId}`);
        env['CLOUDSDK_CORE_PROJECT'] = lastKnownProjectId;
      }

      const accessControlResult = accessControl.check(args.join(' '));
      if (accessControlResult.permitted === false) {
        return accessControlResult.message;
      }
    
      const cleanArgs = args;
    
      const command = {
        tool: tool,
        args: cleanArgs,
      };
    
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';

        const child = child_process.spawn(command.tool, command.args, {
          env,
          shell: true // Using shell to correctly handle quoted arguments
        });
    
        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
    
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });
    
        child.on('close', (code) => {
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
            resolve(`Error: Command failed with exit code ${code}. Stderr: ${stderr}`);
          }
        });
    
        child.on('error', (err) => {
          resolve(`Failed to start the ${command.tool} process: ${err.message}`);
        });
      });
    }
}

export const googleCloudSdkTool = new GoogleCloudSDK();