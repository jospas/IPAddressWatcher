# AWS IP Address Range Change Watcher (1.0.0)

Author: Josh Passenger (jospas@amazon.com)

This sample code shows how to listen to the [global IP address range change SNS topic](https://docs.aws.amazon.com/general/latest/gr/aws-ip-ranges.html#subscribe-notifications) and tracks the state of a set of AWS Regions and Services. 

The latest IP address ranges are stored in a DynamoDB table and changes are optionally notified via SNS and Slack web hook.

## Installation

Install Node.js locally or on your build server.

On a mac install Homebrew then NPM:

	brew install npm
	
On Linux install npm via package manager.

Then install serverless globally:

	npm install -g serverless

The package comes initialised with dependencies, to download them run the following from the project root directory:

	npm install

## Creating a Slack Web Hook

If you intend to send messages to Slack follow the steps to [generate a new web hook](https://get.slack.help/hc/en-us/articles/115005265063-Incoming-WebHooks-for-Slack).

## Pre-deployment configuration

### Configure deployment credentials

You will need to select a local AWS named credential profile or if running from an EC2 instance running in an IAM Role. Either edit or remove this parameter serverless.yml accordingly:

	profile: <profileName>

## Post-deployment configuration

After deployment the following properties are editable as environment variables of the deployed Lambda function. Either edit them in the serverless.yml file prior to deployment or change them via the Lambda console post deployment.

### Sending messages to Slack

If you wish to send messages to Slack, update the serverless.yml file with your web hook URL generated as per above:

	PUBLISH_SLACK: true
	PUBLISH_SLACK_WEBHOOK: <web hook url>
	
### Broadcast to SNS

You may also enable SNS message broadcasts using the format defined below to programatically consume notifications for specific services and regions.

	PUBLISH_SNS: true

## AWS Deployment

Build and deploy the package to your account using serverless. You may optionally override the stage name (default: dev)

	serverless deploy [--stage <stageName>]

Depending on your configuration, AWS IP address range changes will be sent to Slack and published to SNS where you can optionally subscribe email, SMS and programatic consumers.

The deployment role will **require IAM permissions** to create the IAM role used by the Lambda and the relevant resources.

## Resources created

Serverless uses CloudFormation as the primary deployment mechanism and this stack creates the following resources:

- Lambda function subscribed to the [global IP address range change SNS topic](https://docs.aws.amazon.com/general/latest/gr/aws-ip-ranges.html#subscribe-notifications)
- IAM role for Lambda function
- Output SNS topic
- Serverless deployment bucket
- DynamoDB table

## Subscribing for changes

Feel free to add additional subscribers to the SNS topic such as SMS, email targets or programatic targets such as Lambda and SQS.

Lambda, SQS and web-hook subscribers receive a JSON message as defined below.

### Output SNS message format

The message format published to SNS for Lambda, SQS and web-hook subscribers is:

```javascript
{
	"region": "ap-southeast-2",
	"service": "S3",
	"oldRange": [
		"52.92.52.0/22",
		"52.95.128.0/21",
		"54.231.248.0/22"
	],
	"newRange": [
		"52.92.52.0/22",
		"52.95.128.0/21",
		"54.231.248.0/22",
		"54.231.252.0/24"
	]
}
```