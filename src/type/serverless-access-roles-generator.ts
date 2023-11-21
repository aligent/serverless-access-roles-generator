import type Service from 'serverless/classes/Service';
import type { Outputs } from 'serverless/plugins/aws/provider/awsProvider';

export type PrincipalInfo = {
    principalAccountId: string;
    principalRoleName: string;
    externalId: string;
};

export type AccessRolesGenerator = {
    principalAccountId: string;
    principalRoleName: string;
    externalId: string;
    exportPrefix: string;
    outDir: string;
    outFilename: string;
};

export type Export = {
    ExportingStackId: string;
    Name: string;
    Value: string;
};

export type ListExportData = {
    Exports: Export[];
    NextToken: string;
};

export type ResourceExport = {
    arn: string;
    description: string;
    roleOutputKey: string;
};

export type ResourceOutput = {
    arn: string;
    description: string;
    role: string;
};

export type ServerlessResources = Service['resources'] & {
    Outputs?: Outputs;
};
