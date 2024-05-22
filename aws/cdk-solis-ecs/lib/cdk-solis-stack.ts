import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";

interface EcsEfsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class CdkSolisStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EcsEfsStackProps) {
    super(scope, id, props);

    // ECS Cluster
    const cluster = new ecs.Cluster(this, "ark-solis-production", {
      vpc: props.vpc
    });

    // Create an EFS file system
    const fileSystem = new efs.FileSystem(this, "ArkSolisFileSystem", {
      vpc: props.vpc,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.DESTROY // Ensure EFS is deleted on stack deletion
    });

    // Security Group for EFS
    const efsSecurityGroup = new ec2.SecurityGroup(this, "EfsSecurityGroup", {
      vpc: props.vpc,
      allowAllOutbound: true
    });

    efsSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(2049),
      "Allow NFS traffic from VPC"
    );

    // Security Group for ECS Tasks
    const ecsTaskSecurityGroup = new ec2.SecurityGroup(this, "EcsTaskSG", {
      vpc: props.vpc,
      allowAllOutbound: true
    });

    // Allow ECS tasks to access EFS
    fileSystem.connections.allowFrom(
      ecsTaskSecurityGroup,
      ec2.Port.tcp(2049),
      "Allow ECS tasks to access EFS"
    );

    // IAM role for ECS task execution
    const taskExecutionRole = new iam.Role(this, "TaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        )
      ]
    });

    // Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "ArkSolisTaskDef",
      {
        memoryLimitMiB: 4096,
        cpu: 2048,
        executionRole: taskExecutionRole
      }
    );

    // ECR Repository
    const ecrRepository = ecs.ContainerImage.fromRegistry("my-image");

    // Log Group
    const logGroup = new logs.LogGroup(this, "LogGroup", {
      retention: logs.RetentionDays.ONE_WEEK
    });

    // Logging
    const logging = new ecs.AwsLogDriver({
      logGroup,
      streamPrefix: "Solis"
    });

    // Container Definition
    const container = taskDefinition.addContainer("ArkSolisContainer", {
      image: ecrRepository,
      memoryLimitMiB: 4096,
      logging,
      environment: {
        FILE_PATH: "/data"
      }
    });

    container.addPortMappings({
      containerPort: 7777
    });

    // Mount the EFS file system
    const volumeName = "EfsVolume";
    taskDefinition.addVolume({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: "ENABLED"
      }
    });

    container.addMountPoints({
      sourceVolume: volumeName,
      containerPath: "/data",
      readOnly: false
    });

    // Application Load Balancer
    const lb = new elbv2.ApplicationLoadBalancer(this, "LB", {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: ecsTaskSecurityGroup
    });

    const listener = lb.addListener("Listener", {
      port: 80,
      open: true
    });

    // ECS Service
    const service = new ecs.FargateService(this, "ark-solis-service", {
      cluster,
      taskDefinition,
      securityGroups: [ecsTaskSecurityGroup],
      desiredCount: 1
    });

    listener.addTargets("ECS", {
      port: 80,
      targets: [service],
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: "200"
      }
    });

    // Route 53 Hosted Zone
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: "arkproject.dev"
    });

    new route53.ARecord(this, "AliasRecord", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(lb)
      ),
      recordName: "staging.solis"
    });

    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: lb.loadBalancerDnsName,
      description: "DNS Name of the Load Balancer"
    });
  }
}
