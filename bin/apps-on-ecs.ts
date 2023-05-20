#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AppsOnEcsStack } from '../lib/apps-on-ecs-stack';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Duration } from 'aws-cdk-lib';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

const app = new cdk.App();
new AppsOnEcsStack(app, 'AppsOnEcsStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  vpcName: 'AriefhInfraStack/dev-vpc',
  ecsClusterName: 'AriefhEcsClusterStack-ecscluster7830E7B5-PtVsFrRPxFMU',
  ecsClusterSgIds: ['sg-0d902126668d28b3d', 'sg-0dd10b9487ef04e7a'],
  svcConnect: {
    dnsNamespace: 'dev.ariefh.internal',
    proxyCpu: 256,
    proxyMemoryLimit: 64,
  },
  asg: {
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6A, ec2.InstanceSize.XLARGE),
    machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
    minCapacity: 2,
    maxCapacity: 5,
    desiredCapacity: 2,
    cooldown: Duration.minutes(5)
  },
  services: [
    {
      svcName: "app1",
      desiredCount: 2,
      placementStrategies: [ecs.PlacementStrategy.spreadAcrossInstances()],
      autoscaling: {
        min: 1,
        max: 5,
        // cpuOpts: {
        //   targetUtilizationPercent: 30,
        //   scaleInCooldown: cdk.Duration.seconds(60),
        //   scaleOutCooldown: cdk.Duration.seconds(60)
        // },
        requestCountOpts: {
          requestsPerTarget: 50,
          scaleInCooldown: cdk.Duration.seconds(60),
          scaleOutCooldown: cdk.Duration.seconds(60)
        }
      },
      alb: {
        albName: 'shared-alb',
        listenerProps: {
        },
        targetProps: {
          deregistrationDelay: Duration.seconds(5),
          healthCheck: {
            healthyHttpCodes: '200,303', 
            timeout: Duration.seconds(5), 
            interval: Duration.seconds(30), 
            path: "/",
            healthyThresholdCount: 2
          },
        }
      },
      cntr: {
        options: {
          image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
          cpu: 256,
          memoryLimitMiB: 512,
          portMappings: [{
            name: 'app1',
            containerPort: 80
          }],
          // healthCheck: {},
          essential: true,
        },
        efsMount: {
          efsId: 'fs-03b2cba49c1ad64c0',
          // efsSecurityGroupId: '',
          mountMapping: [
            {
              sourceVolume: 'app',
              // must create first. https://docs.aws.amazon.com/efs/latest/ug/mounting-IAM-option.html
              efsPath: '/mpi/2023-05-01/app1',
              containerPath: '/usr/app',
            }
          ],
        }
      }
    },
    {
      svcName: "app2",
      desiredCount: 1,
      placementStrategies: [],
      // not autoscaled
      alb: {
        albName: 'shared-alb',
        listenerProps: {
        },
        targetProps: {
          deregistrationDelay: Duration.seconds(5),
          healthCheck: {
            healthyHttpCodes: '200', 
            timeout: Duration.seconds(5), 
            interval: Duration.seconds(30), 
            path: "/",
            healthyThresholdCount: 2
          },
          priority: 100,
          conditions: [
            elbv2.ListenerCondition.queryStrings([{key: "q", value: "app2"}])
          ]
        }
      },
      cntr: {
        options: {
          image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
          cpu: 256,
          memoryLimitMiB: 512,
          portMappings: [{
            name: 'app2',
            containerPort: 80
          }],
          essential: true,
        },
        efsMount: {
          efsId: 'fs-03b2cba49c1ad64c0',
          mountMapping: [
            {
              sourceVolume: 'app',
              efsPath: '/mpi/2023-05-01/app2',
              containerPath: '/usr/app',
            }
          ],
        }
      }
    }
  ]
});