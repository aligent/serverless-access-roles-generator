import type CloudFormation from 'aws-sdk/clients/cloudformation';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import type {
    CloudFormationResource,
    IamRoleStatement,
} from 'serverless/plugins/aws/provider/awsProvider';
import {
    Export,
    PrincipalInfo,
    ResourceExport,
    ResourceOutput,
} from '../type/serverless-access-roles-generator';

export const DEFAULT_EXPORT_PREFIX = 'aser' as const;
export const DEFAULT_OUT_DIR = 'dist/data' as const;
export const DEFAULT_OUT_FILENAME = 'service-outputs.json' as const;

function pascalCase(str: string) {
    const firstChar = str[0] as string;
    return str.replace(firstChar, firstChar.toUpperCase());
}

export function exportToFile(
    currentDir: string,
    targetDir: string,
    fileName: string,
    data: string,
) {
    const outDir = path.join(currentDir, targetDir);
    mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, fileName);
    writeFileSync(outPath, data);

    return outPath;
}

function splitExportName(exportName: string) {
    const exportNameArray = exportName.split(':');

    return {
        prefix: exportNameArray[0] as string,
        stackName: exportNameArray[1] as string,
        name: exportNameArray[2] as string,
        type: exportNameArray[3] as string,
        resource: exportNameArray[4] as string,
    };
}

export function splitResourceExportKey(key: string) {
    const exportKeyArray = key.split(':');

    if (exportKeyArray.length !== 3) {
        throw new Error(`Incorrect resource export key: ${key}`);
    }

    return {
        stackName: exportKeyArray[0] as string,
        name: exportKeyArray[1] as string,
        type: exportKeyArray[2] as string,
    };
}

export function generateIamRoleResourceLogicalName(
    stackName: string,
    name: string,
    type: string,
    postfix = 'AccessRole',
) {
    const formattedStackName = stackName
        .split('-')
        .map((word) => pascalCase(word))
        .join('');
    const formattedName = pascalCase(name);
    const formattedType = pascalCase(type);

    return `${formattedStackName}${formattedName}${formattedType}${postfix}`;
}

export function collectResourceExportsByPrefix(
    exportPrefix: string,
    exports: Export[],
) {
    const resources: Record<string, ResourceExport> = {};

    for (const { Name, Value } of exports) {
        const { prefix, stackName, name, type, resource } =
            splitExportName(Name);

        if (prefix === exportPrefix) {
            const key = `${stackName}:${name}:${type}`;

            if (!resources[key])
                resources[key] = {
                    arn: '',
                    description: '',
                    roleOutputKey: '',
                };

            if (resource === 'arn')
                (resources[key] as ResourceExport).arn = Value;

            if (resource === 'description')
                (resources[key] as ResourceExport).description = Value;
        }
    }

    return resources;
}

function defaultLambdaFunctionPolicyStatements(
    functionArn: string,
    logGroupArn?: string,
): IamRoleStatement[] {
    const statements: IamRoleStatement[] = [
        {
            Effect: 'Allow',
            Action: ['lambda:InvokeFunction'],
            Resource: functionArn,
        },
    ];

    if (logGroupArn)
        statements.push({
            Effect: 'Allow',
            Action: ['logs:DescribeLogStreams', 'logs:GetLogEvents'],
            Resource: logGroupArn,
        });

    return statements;
}

function defaultStateMachinePolicyStatements(arn: string): IamRoleStatement[] {
    const name = arn.split(':')[-1] as string;
    return [
        {
            // Grants permission to list and start a state machine execution
            Effect: 'Allow',
            Action: ['states:ListExecutions', 'states:StartExecution'],
            Resource: arn,
        },
        {
            // Grants permission to describe an execution
            Effect: 'Allow',
            Action: ['states:DescribeExecution'],
            Resource: [
                {
                    'Fn::Sub': `arn:aws:states:\${AWS::Region}:\${AWS::AccountId}:execution:${name}:*`,
                },
                {
                    'Fn::Sub': `arn:aws:states:\${AWS::Region}:\${AWS::AccountId}:express:${name}:*:*`,
                },
            ],
        },
        {
            // Grants permission to stop an execution
            Effect: 'Allow',
            Action: ['states:StopExecution'],
            Resource: {
                'Fn::Sub': `arn:aws:states:\${AWS::Region}:\${AWS::AccountId}:execution:${name}:*`,
            },
        },
    ];
}

export function generatePolicyStatementsByType(arn: string, type: string) {
    if (type === 'function') return defaultLambdaFunctionPolicyStatements(arn);

    if (type === 'stateMachine')
        return defaultStateMachinePolicyStatements(arn);

    return [];
}

export function generateAccessRoleResource(
    stackName: string,
    name: string,
    principalInfo: PrincipalInfo,
    policyStatements: IamRoleStatement[],
): CloudFormationResource {
    return {
        Type: 'AWS::IAM::Role',
        Properties: {
            RoleName: `${stackName}-${name}`,
            Description: `Access role to ${name} of ${stackName}`,
            AssumeRolePolicyDocument: {
                Version: '2012-10-17',
                Statement: {
                    Effect: 'Allow',
                    Action: ['sts:AssumeRole'],
                    Principal: {
                        AWS: `arn:aws:sts::${principalInfo.principalAccountId}:assumed-role/${principalInfo.principalRoleName}/CognitoIdentityCredentials`,
                    },
                    Condition: {
                        StringEquals: {
                            'sts:ExternalId': `${principalInfo.externalId}`,
                        },
                    },
                },
            },
            Policies: [
                {
                    PolicyName: 'EmbeddedInlinePolicy',
                    PolicyDocument: {
                        Version: '2012-10-17',
                        Statement: policyStatements,
                    },
                },
            ],
        },
    };
}

export function generateAccessRoleOutput(
    stackName: string,
    name: string,
    logicalName: string,
) {
    return {
        Description: `Arn of ${stackName}-${name} access role`,
        Value: { ['Fn::GetAtt']: [logicalName, 'Arn'] },
    };
}

export function collectAccessRolesArnFromStackOutputs(
    stackOutputs: CloudFormation.Outputs,
    resourceExports: Record<string, ResourceExport>,
) {
    const resourceOutputs: Record<string, Record<string, ResourceOutput>> = {};

    for (const key in resourceExports) {
        const stackName = key.split(':')[0] as string;
        const fullName = key.split(':')[1] as string;
        const { arn, description, roleOutputKey } = resourceExports[
            key
        ] as ResourceExport;

        const cfnRoleOutput = stackOutputs.filter(
            (output) => output.OutputKey === roleOutputKey,
        )[0] as CloudFormation.Output;

        if (!cfnRoleOutput) {
            throw new Error(`Unable to find output: ${roleOutputKey}`);
        }

        const temp: Record<string, ResourceOutput> = {
            [fullName]: {
                arn,
                description,
                role: cfnRoleOutput.OutputValue as string,
            },
        };

        if (!resourceOutputs[stackName]) resourceOutputs[stackName] = {};

        resourceOutputs[stackName] = {
            ...resourceOutputs[stackName],
            ...temp,
        };
    }

    return resourceOutputs;
}
