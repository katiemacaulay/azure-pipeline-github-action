import * as core from '@actions/core';

export class TaskParameters {
    private static taskparams: TaskParameters;
    private _azureDevopsProjectUrl: string;
    private _azurePipelineName: string;
    private _azureDevopsToken: string;
    private _azurePipelineVariables: string;
    private _azurePipelineBranch: string;

    private constructor() {
        this._azureDevopsProjectUrl = core.getInput('azure-devops-project-url', { required: true });
        this._azurePipelineName = core.getInput('azure-pipeline-name', { required: true });
        this._azureDevopsToken = core.getInput('azure-devops-token', { required: true });
        this._azurePipelineVariables = core.getInput('azure-pipeline-variables', { required: false });
        this._azurePipelineBranch = core.getInput('azure-pipeline-branch', { required: false });
    }

    public static getTaskParams() {
        if (!this.taskparams) {
            this.taskparams = new TaskParameters();
        }

        return this.taskparams;
    }

    public get azureDevopsProjectUrl() {
        return this._azureDevopsProjectUrl;
    }

    public get azurePipelineName() {
        return this._azurePipelineName;
    }

    public get azureDevopsToken() {
        return this._azureDevopsToken;
    }

    public get azurePipelineVariables() {
        return this._azurePipelineVariables;
    }

    public get azurePipelineBranch() {
        return this._azurePipelineBranch;
    }
}