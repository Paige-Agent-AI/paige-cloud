import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  DescribeUserPoolClientCommand,
  ForgotPasswordCommand,
  GetUserCommand,
  GlobalSignOutCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  SignUpCommand
} from "@aws-sdk/client-cognito-identity-provider";
import { ExecuteStatementCommand, RDSDataClient } from "@aws-sdk/client-rds-data";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { FetchError, JwksValidationError, JwtBaseError } from "aws-jwt-verify/error";
import { createAccountHandler } from "./handler.mjs";
import { createWorkloadObservation, parseInspectionScope, parseInspectionRecoveryPoint } from "./workload-observation.mjs";

function createCognitoIdentity({ userPoolId, clientId }) {
  const cognito = new CognitoIdentityProviderClient({});
  // A reserved email attempt can be spent at most once, even if the provider response is lost.
  const emailCognito = new CognitoIdentityProviderClient({ maxAttempts: 1 });
  const jwt = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" });
  let clientSecret;

  async function secretHash(email) {
    if (!clientSecret) {
      const response = await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }));
      clientSecret = response.UserPoolClient?.ClientSecret;
      if (!clientSecret) throw new Error("A confidential Cognito app client is required");
    }
    // Cognito's confidential-client HMAC binds the submitted username to this app client.
    return createHmac("sha256", clientSecret).update(email + clientId).digest("base64");
  }

  async function signedToken(token) {
    try {
      return await jwt.verify(token);
    } catch (error) {
      if (error instanceof JwtBaseError && !(error instanceof FetchError) && !(error instanceof JwksValidationError)) {
        return null;
      }
      throw error;
    }
  }

  return {
    async signUp(email) {
      return emailCognito.send(new SignUpCommand({
        ClientId: clientId, SecretHash: await secretHash(email), Username: email,
        // Public callers cannot choose or know a password before ownership of the email is established.
        Password: randomBytes(32).toString("base64url"),
        UserAttributes: [{ Name: "email", Value: email }]
      }));
    },
    async confirmSignUp(email, code, password) {
      await cognito.send(new ConfirmSignUpCommand({
        ClientId: clientId, SecretHash: await secretHash(email), Username: email, ConfirmationCode: code
      }));
      try {
        await cognito.send(new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId, Username: email, Password: password, Permanent: true
        }));
      } catch (error) {
        const unverified = new Error("Verified account password could not be confirmed", { cause: error });
        unverified.name = "EnrollmentPasswordUnconfirmed";
        throw unverified;
      }
    },
    async resendCode(email) {
      return emailCognito.send(new ResendConfirmationCodeCommand({
        ClientId: clientId, SecretHash: await secretHash(email), Username: email
      }));
    },
    async signIn(email, password) {
      const response = await cognito.send(new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: email, PASSWORD: password, SECRET_HASH: await secretHash(email) }
      }));
      if (response.ChallengeName) throw new Error("Unexpected Cognito sign-in challenge");
      return {
        token: response.AuthenticationResult?.AccessToken,
        lifetimeSeconds: response.AuthenticationResult?.ExpiresIn
      };
    },
    async verify(token) {
      const claims = await signedToken(token);
      if (!claims) return null;

      let user;
      try {
        // Local JWT validation alone would keep accepting revoked tokens until expiry.
        user = await cognito.send(new GetUserCommand({ AccessToken: token }));
      } catch (error) {
        if (error.name === "NotAuthorizedException" || error.name === "UserNotFoundException") return null;
        throw error;
      }
      const attributes = new Map(user.UserAttributes?.map(({ Name, Value }) => [Name, Value]));
      if (attributes.get("sub") !== claims.sub || attributes.get("email_verified") !== "true") return null;
      const email = attributes.get("email")?.trim().toLowerCase();
      return email ? { issuer: claims.iss, subject: claims.sub, email } : null;
    },
    async signOut(token) {
      if (await signedToken(token)) {
        await cognito.send(new GlobalSignOutCommand({ AccessToken: token }));
      }
    },
    async startRecovery(email) {
      return emailCognito.send(new ForgotPasswordCommand({
        ClientId: clientId, SecretHash: await secretHash(email), Username: email
      }));
    },
    async finishRecovery(email, code, password) {
      await cognito.send(new ConfirmForgotPasswordCommand({
        ClientId: clientId, SecretHash: await secretHash(email), Username: email,
        ConfirmationCode: code, Password: password
      }));
      try {
        await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: email }));
      } catch (error) {
        const unverified = new Error("Password reset session revocation could not be confirmed", { cause: error });
        unverified.name = "RecoveryRevocationUnconfirmed";
        throw unverified;
      }
    }
  };
}

function createAccountRecords({ resourceArn, secretArn, database }) {
  if (!resourceArn || !secretArn || !database) throw new Error("The Cloud accounts database is required");
  const client = new RDSDataClient({});

  async function query(sql, values) {
    const response = await client.send(new ExecuteStatementCommand({
      resourceArn, secretArn, database, sql,
      parameters: Object.entries(values).map(([name, value]) => ({ name, value: { stringValue: value } }))
    }));
    return response.records ?? [];
  }

  async function call(sql, values, decode = value => value) {
    const field = (await query(sql, values))[0]?.[0];
    if (field?.isNull) return null;
    if (typeof field?.stringValue !== "string") throw new Error("Invalid Cloud account response");
    return decode(field.stringValue);
  }

  return {
    reserveAccountEmail(lane, network, recipient) {
      return call("SELECT CAST(cloud_accounts.reserve_account_email(:lane, :network, :recipient) AS text)",
        { lane, network, recipient }, value => value === "true");
    },
    recordIdentity({ issuer, subject, email }) {
      return call("SELECT CAST(cloud_accounts.record_verified_identity(:issuer, :subject, :email) AS text)",
        { issuer, subject, email });
    },
    findIdentity({ issuer, subject }) {
      return call("SELECT CAST(cloud_accounts.find_verified_identity(:issuer, :subject) AS text)", { issuer, subject });
    },
    accountDetails(actor) {
      return call("SELECT CAST(cloud_accounts.account_details(CAST(:actor AS uuid)) AS text)", { actor }, JSON.parse);
    },
    updateDisplayName(actor, name) {
      return call("SELECT CAST(cloud_accounts.update_display_name(CAST(:actor AS uuid), :name) AS text)",
        { actor, name }, JSON.parse);
    },
    onboardOrganization(actor, name) {
      return call("SELECT CAST(cloud_accounts.onboard_organization(CAST(:actor AS uuid), :name) AS text)",
        { actor, name }, JSON.parse);
    },
    organizationDetails(actor, organization) {
      return call("SELECT CAST(cloud_accounts.organization_details(CAST(:actor AS uuid), CAST(:organization AS uuid)) AS text)",
        { actor, organization }, JSON.parse);
    },
    renameOrganization(actor, organization, expectedName, name) {
      return call(`SELECT CAST(cloud_accounts.rename_organization(
        CAST(:actor AS uuid), CAST(:organization AS uuid), :expectedName, :name) AS text)`,
        { actor, organization, expectedName, name }, JSON.parse);
    },
    registryProjects(actor, organization) {
      return call("SELECT CAST(cloud_accounts.registry_list_projects(CAST(:actor AS uuid), CAST(:organization AS uuid)) AS text)",
        { actor, organization }, JSON.parse);
    },
    registryCreateProject(actor, organization, project, name) {
      return call("SELECT CAST(cloud_accounts.registry_create_project(CAST(:actor AS uuid), CAST(:organization AS uuid), :project, :name) AS text)",
        { actor, organization, project, name }, JSON.parse);
    },
    async registryApplications(actor, organization, project) {
      const rows = await query("SELECT cloud_accounts.registry_list_applications(CAST(:actor AS uuid), CAST(:organization AS uuid), :project)",
        { actor, organization, project });
      if (rows.length === 1 && rows[0][0]?.isNull) return null;
      if (rows.length === 1 && rows[0][0]?.stringValue === "") return [];
      if (!rows.length) throw new Error("Invalid registry response");
      return rows.map(([field]) => JSON.parse(field.stringValue));
    },
    reserveInspection(actor, { organization, project, application, environment }) {
      return call(`SELECT cloud_accounts.reserve_workload_observation(CAST(:actor AS uuid),
        CAST(:organization AS uuid), :project, :application, :environment)`,
        { actor, organization, project, application, environment });
    },
    readWorkloadConfiguration(actor, { organization, project, application, environment }, revision) {
      return call(`SELECT CAST(cloud_accounts.read_workload_configuration(CAST(:actor AS uuid),
        CAST(:organization AS uuid), :project, :application, :environment, CAST(NULLIF(:revision, '') AS integer)) AS text)`,
        { actor, organization, project, application, environment, revision: revision ?? "" }, JSON.parse);
    },
    saveWorkloadConfiguration(actor, { organization, project, application, environment }, configuration) {
      return call(`SELECT CAST(cloud_accounts.save_workload_configuration_v2(CAST(:actor AS uuid),
        CAST(:organization AS uuid), :project, :application, :environment,
        CAST(:revision AS integer), :level, CAST(:timeout AS integer)) AS text)`, {
        actor, organization, project, application, environment, revision: String(configuration.expectedRevision),
        level: configuration.logLevel, timeout: String(configuration.requestTimeoutMs)
      }, JSON.parse);
    },
    registryRegisterApplication(actor, organization, project, { id, name, kind, repository, environment }) {
      return call(`SELECT CAST(cloud_accounts.registry_register_application(CAST(:actor AS uuid), CAST(:organization AS uuid),
        :project, :id, :name, :kind, NULLIF(:repository, ''), :environment) AS text)`,
        { actor, organization, project, id, name, kind, repository, environment }, JSON.parse);
    }
  };
}

const {
  CLOUD_SITE_ORIGIN, CLOUD_EVALUATORS, CLOUD_ENROLLMENT_MODE, CLOUD_EDGE_KEY, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID,
  CLOUD_DB_CLUSTER_ARN, CLOUD_DB_RUNTIME_SECRET_ARN, CLOUD_DB_NAME,
  CLOUD_INSPECTION_SCOPE, CLOUD_INSPECTION_ALIAS, CLOUD_INSPECTION_RECOVERY_POINT
} = process.env;
if (!CLOUD_EDGE_KEY) throw new Error("The Cloud edge key is required");

const records = createAccountRecords({
  resourceArn: CLOUD_DB_CLUSTER_ARN, secretArn: CLOUD_DB_RUNTIME_SECRET_ARN, database: CLOUD_DB_NAME
});
let workloadObservation;
if (CLOUD_INSPECTION_ALIAS) {
  const scope = parseInspectionScope(CLOUD_INSPECTION_SCOPE);
  const { decideGovernedExecution } = await import("./canonical-spine/governedExecution.mjs");
  const { InvokeCommand, LambdaClient } = await import("@aws-sdk/client-lambda");
  const lambda = new LambdaClient({ maxAttempts: 1 });
  workloadObservation = createWorkloadObservation({
    scope,
    recoveryPoint: parseInspectionRecoveryPoint(CLOUD_INSPECTION_RECOVERY_POINT),
    decide: decideGovernedExecution,
    reserve: records.reserveInspection,
    invoke: args => lambda.send(new InvokeCommand({
      FunctionName: CLOUD_INSPECTION_ALIAS,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(args))
    }), { abortSignal: AbortSignal.timeout(4500) })
  });
}

export const handler = createAccountHandler({
  origin: CLOUD_SITE_ORIGIN,
  edgeKey: CLOUD_EDGE_KEY,
  consoleHtml: readFileSync(new URL("./mission-control.html", import.meta.url), "utf8"),
  evaluatorEmails: (CLOUD_EVALUATORS ?? "").split(",").filter(Boolean),
  enrollmentMode: CLOUD_ENROLLMENT_MODE,
  identity: createCognitoIdentity({
    userPoolId: COGNITO_USER_POOL_ID, clientId: COGNITO_CLIENT_ID
  }),
  records,
  workloadObservation
});
