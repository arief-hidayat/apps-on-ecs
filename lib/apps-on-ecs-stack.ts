import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Duration } from 'aws-cdk-lib';
import { escape } from 'querystring';

interface EfsMountMapping {
  efsPath: string
  containerPath: string
  sourceVolume: string 
}
interface EfsMount {
  efsId?: string
  efsSecurityGroupId?: string
  mountMapping: EfsMountMapping[] 
}
interface Asg {
  instanceType: ec2.InstanceType
  machineImage: ec2.IMachineImage
  desiredCapacity: number
  minCapacity?: number
  maxCapacity?: number
  cooldown: Duration
}
interface EcsContainer {
  // imageTag: string
  // containerPort: number
  options: ecs.ContainerDefinitionOptions
  efsMount?: EfsMount
}
interface Alb {
  albName: string,
  listenerProps: elbv2.BaseApplicationListenerProps,
  targetProps: elbv2.AddApplicationTargetsProps
}
interface EcsSvc {
  svcName: string
  desiredCount: number
  placementStrategies: ecs.PlacementStrategy[]
  maxHealthyPercent?: number,
  minHealthyPercent?: number,
  cntr: EcsContainer
  autoscaling?: AutoscaleTask
  alb: Alb
}
interface ReqCountOpts {
  requestsPerTarget: number,
  scaleInCooldown?: cdk.Duration,
  scaleOutCooldown?: cdk.Duration,
}
interface AutoscaleTask {
  min: number,
  max: number,
  cpuOpts?: ecs.CpuUtilizationScalingProps,
  requestCountOpts?: ReqCountOpts
}

interface EcsSvcConnect {
  dnsNamespace: string,
  proxyCpu: number,
  proxyMemoryLimit: number,
}

interface AppsOnEcsStackProps extends cdk.StackProps {
  vpcName: string
  ecsClusterName: string
  ecsClusterSgIds: string[]
  svcConnect?: EcsSvcConnect
  asg: Asg
  services: EcsSvc[]
}

export class AppsOnEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppsOnEcsStackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'dev-vpc', {vpcName: props.vpcName});
    const svcConnect = props.svcConnect
    // ECS cluster on EC2 with cluster ASG capacity provider
    const ecsClusterSgs: ec2.ISecurityGroup[] = []
    props.ecsClusterSgIds.forEach((sgId) => {
      ecsClusterSgs.push(ec2.SecurityGroup.fromLookupById(this, sgId, sgId))
    })
    const ecsCluster = ecs.Cluster.fromClusterAttributes(this, 'ecs-cluster', {vpc: vpc, clusterName: props.ecsClusterName, securityGroups: ecsClusterSgs});
    // security groups
    const dbSG = new ec2.SecurityGroup(this, 'DBSG', { vpc });
    const appSG = new ec2.SecurityGroup(this, 'AppSG', { vpc });
    const lbSG = new ec2.SecurityGroup(this, 'LBSG', { vpc });
    dbSG.addIngressRule(ec2.Peer.securityGroupId(appSG.securityGroupId), ec2.Port.tcp(3306));
    appSG.addIngressRule(ec2.Peer.securityGroupId(lbSG.securityGroupId), ec2.Port.tcp(80));
    // allow service-to-service
    appSG.addIngressRule(ec2.Peer.securityGroupId(appSG.securityGroupId), ec2.Port.allTcp());

    const albMap: { [id: string]: elbv2.ApplicationListener; } = {};

    const logGroup = new logs.LogGroup(this, 'log-group', {retention: logs.RetentionDays.ONE_WEEK})

    const ecsServiceMap: { [id: string]: ecs.IEc2Service; } = {};
    // services
    for(let svc of props.services) {
      const cntr = svc.cntr
      const efsList:efs.FileSystem[] = []
      if(!cntr.options.cpu || !cntr.options.memoryLimitMiB) {
        break
      }
      const cntrCpu = cntr.options.cpu || 0
      const cntrMemory = cntr.options.memoryLimitMiB || 0
      
      // task definition
      const taskDef = svcConnect ? 
      new ecs.TaskDefinition(this, `task-def-${svc.svcName}`, {
        compatibility: ecs.Compatibility.EC2,
        networkMode: ecs.NetworkMode.AWS_VPC,
        cpu: `${cntrCpu + svcConnect.proxyCpu}`,
        memoryMiB: `${cntrMemory + svcConnect.proxyMemoryLimit}`,
      }) :
      new ecs.Ec2TaskDefinition(this, `task-def-${svc.svcName}`, {
        networkMode: ecs.NetworkMode.AWS_VPC
      });
      // prepare EFS if specified
      if (cntr.efsMount) {
        const efsSg = cntr.efsMount.efsSecurityGroupId ? 
          ec2.SecurityGroup.fromSecurityGroupId(this, `efs-sg-${svc.svcName}`, cntr.efsMount.efsSecurityGroupId, { allowAllOutbound: false }): 
          new ec2.SecurityGroup(this, `efs-sg-${svc.svcName}`, { vpc: vpc, allowAllOutbound: false, description: 'Security group used by EFS'});
        const fileSystem = cntr.efsMount.efsId ?
        efs.FileSystem.fromFileSystemAttributes(this, `ecs-efs-${svc.svcName}`, { fileSystemId: cntr.efsMount.efsId, securityGroup: efsSg }): 
        new efs.FileSystem(this, `ecs-efs-${svc.svcName}`, {
          vpc: vpc, encrypted: true, lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS, 
          performanceMode: efs.PerformanceMode.GENERAL_PURPOSE, throughputMode: efs.ThroughputMode.BURSTING
        });
        cntr.efsMount.mountMapping.forEach((mapping) => {
        const efsAccessPoint = new efs.AccessPoint(this, `efs-ap-${svc.svcName}`, {fileSystem: fileSystem, path: mapping.efsPath});
        efsAccessPoint.node.addDependency(fileSystem);
        const efsMountPolicy = new iam.PolicyStatement({
          actions: [
              'elasticfilesystem:ClientMount',
              // 'elasticfilesystem:ClientWrite',
              // 'elasticfilesystem:ClientRootAccess'
          ], 
          resources: [
              efsAccessPoint.accessPointArn,
              fileSystem.fileSystemArn
          ]
        })

        taskDef.addToTaskRolePolicy(efsMountPolicy)
        taskDef.addToExecutionRolePolicy(efsMountPolicy)
        taskDef.addVolume({
          name: mapping.sourceVolume,
          efsVolumeConfiguration: {
              fileSystemId: fileSystem.fileSystemId,
              transitEncryption: 'ENABLED',
              authorizationConfig: {
                  accessPointId: efsAccessPoint.accessPointId,
              }
          },
        });
      });
      }
      // container definition
      const containerDef = taskDef.addContainer(`cntr-${svc.svcName}`, {
        ...cntr.options,
        logging: new ecs.AwsLogDriver({
          logGroup: logGroup,
          streamPrefix: svc.svcName,
        })
      })
      // mount EFS if specified
      if (cntr.efsMount) {
        cntr.efsMount.mountMapping.forEach((mapping) => 
          containerDef.addMountPoints({
            containerPath: mapping.containerPath,
            sourceVolume: mapping.sourceVolume,
            readOnly: false,
          })
        );
      }

      // ecs service on EC2
    const ecsSvcProps: ecs.Ec2ServiceProps = {
      cluster: ecsCluster,
      taskDefinition: taskDef,
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [appSG],
      desiredCount: svc.desiredCount,
      placementStrategies: svc.placementStrategies,
      maxHealthyPercent: svc.maxHealthyPercent || 200,
      minHealthyPercent: svc.minHealthyPercent || 50,
    }
    const albService = new ecs.Ec2Service(this, `alb-svc-${svc.svcName}`, svcConnect ? {
      ...ecsSvcProps,
      serviceConnectConfiguration: {
        namespace: svcConnect.dnsNamespace,
        services: [
          {
            portMappingName: cntr.options.portMappings? cntr.options.portMappings[0].name || `${svc.svcName}` :`${svc.svcName}`,
            port: cntr.options.portMappings? cntr.options.portMappings[0].containerPort : 80
          }
        ],
        logDriver: new ecs.AwsLogDriver({
          logGroup: logGroup,
          streamPrefix: `${svc.svcName}-envoy`,
        })
      }
    }: ecsSvcProps);
    ecsServiceMap[svc.svcName] = albService

    // albService.node.addDependency(rdsInstance);
    const albObj: Alb = svc.alb
    // create new ALB or reuse
    if(!albMap[albObj.albName]) {
      const lb = new elbv2.ApplicationLoadBalancer(this, albObj.albName, { vpc, internetFacing: true, securityGroup: lbSG });
      const lbListener = lb.addListener(`listener-${svc.svcName}`, { ...albObj.listenerProps, port: 80 });
      new cdk.CfnOutput(this, `ecsLbDnsName-${albObj.albName}`, {
        value: lb.loadBalancerDnsName,
        description: 'ECS Load Balancer DNS Name',
      });
      albMap[albObj.albName] = lbListener
    }
    // create ALB target
    const targetGroup = albMap[albObj.albName].addTargets(`tg-${svc.svcName}`, {
      ...albObj.targetProps,
      port: 80,
      targetGroupName: `tg-${svc.svcName}`,
      targets: [albService.loadBalancerTarget({ containerName: `cntr-${svc.svcName}` })],
    });

    // setup task autoscaling
      if(svc.autoscaling) {
        const scaling = albService.autoScaleTaskCount({ minCapacity: svc.autoscaling.min, maxCapacity: svc.autoscaling.max });
        if(svc.autoscaling.cpuOpts) {
          scaling.scaleOnCpuUtilization(`cpu-scaling-${svc.svcName}`, svc.autoscaling.cpuOpts);
        } else if(svc.autoscaling.requestCountOpts) {
          const reqCountOpts: ecs.RequestCountScalingProps = {
            requestsPerTarget: svc.autoscaling.requestCountOpts.requestsPerTarget,
            scaleInCooldown: svc.autoscaling.requestCountOpts.scaleInCooldown,
            scaleOutCooldown: svc.autoscaling.requestCountOpts.scaleOutCooldown,
            targetGroup: targetGroup
          }
          scaling.scaleOnRequestCount(`req-count-scaling-${svc.svcName}`, reqCountOpts)
        }
      }

      efsList.forEach( (fileSystem, i) => {
        fileSystem.connections.allowDefaultPortFrom(albService.connections)
        new cdk.CfnOutput(this, `ecsEfsArn-${svc.svcName}-${i}`, {
          value: fileSystem.fileSystemArn,
          description: `ECS EFS ARN ${i}`,
        });
        new cdk.CfnOutput(this, `ecsEfsId-${svc.svcName}-${i}`, {
          value: fileSystem.fileSystemId,
          description: `ECS EFS Id ${i}`,
        });
      })
    }
  }
}
