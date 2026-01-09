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

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
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

class GoogleCloudSDK extends StructuredTool {
    name = 'google-cloud-sdk';
    description = `Executes a command for a Google Cloud command-line interface: gcloud, gsutil, kubectl, or bq.`

    schema = z.object({
        tool: z.enum(["gcloud", "gsutil", "kubectl", "bq"]).describe("The command-line tool to execute."),
        args: z.array(z.string()).describe("The arguments for the command."),
    });

    async _call(
      { tool, args }: z.infer<this["schema"]>,
      runManager?: CallbackManagerForToolRun,
      config?: RunnableConfig
    ): Promise<string> {
      const accessToken = config?.configurable?.accessToken;
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
        if (accessToken) {
            env['CLOUDSDK_AUTH_ACCESS_TOKEN'] = accessToken;
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
          if (code === 0) {
            resolve(stdout);
          } else {
            resolve(stderr);
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
