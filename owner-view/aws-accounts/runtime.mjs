import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
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

function createCognitoIdentity({ userPoolId, clientId }) {
  const cognito = new CognitoIdentityProviderClient({});
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
    async signUp(email, password) {
      return cognito.send(new SignUpCommand({
        ClientId: clientId, SecretHash: await secretHash(email), Username: email, Password: password,
        UserAttributes: [{ Name: "email", Value: email }]
      }));
    },
    async confirmSignUp(email, code) {
      return cognito.send(new ConfirmSignUpCommand({
        ClientId: clientId, SecretHash: await secretHash(email), Username: email, ConfirmationCode: code
      }));
    },
    async resendCode(email) {
      return cognito.send(new ResendConfirmationCodeCommand({
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
      return cognito.send(new ForgotPasswordCommand({
        ClientId: clientId, SecretHash: await secretHash(email), Username: email
      }));
    },
    async finishRecovery(email, code, password) {
      return cognito.send(new ConfirmForgotPasswordCommand({
        ClientId: clientId, SecretHash: await secretHash(email), Username: email,
        ConfirmationCode: code, Password: password
      }));
    }
  };
}

function createAccountRecords({ resourceArn, secretArn, database }) {
  if (!resourceArn || !secretArn || !database) throw new Error("The Cloud accounts database is required");
  const client = new RDSDataClient({});

  async function call(sql, values, decode = value => value) {
    const response = await client.send(new ExecuteStatementCommand({
      resourceArn, secretArn, database, sql,
      parameters: Object.entries(values).map(([name, value]) => ({ name, value: { stringValue: value } }))
    }));
    const field = response.records?.[0]?.[0];
    if (field?.isNull) return null;
    if (typeof field?.stringValue !== "string") throw new Error("Invalid Cloud account response");
    return decode(field.stringValue);
  }

  return {
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
    registryProjects(actor, organization) {
      return call("SELECT CAST(cloud_accounts.registry_list_projects(CAST(:actor AS uuid), CAST(:organization AS uuid)) AS text)",
        { actor, organization }, JSON.parse);
    },
    registryCreateProject(actor, organization, project, name) {
      return call("SELECT CAST(cloud_accounts.registry_create_project(CAST(:actor AS uuid), CAST(:organization AS uuid), :project, :name) AS text)",
        { actor, organization, project, name }, JSON.parse);
    },
    registryApplications(actor, organization, project) {
      return call("SELECT CAST(cloud_accounts.registry_list_applications(CAST(:actor AS uuid), CAST(:organization AS uuid), :project) AS text)",
        { actor, organization, project }, JSON.parse);
    },
    registryRegisterApplication(actor, organization, project, { id, name, kind, repository, environment }) {
      return call(`SELECT CAST(cloud_accounts.registry_register_application(CAST(:actor AS uuid), CAST(:organization AS uuid),
        :project, :id, :name, :kind, NULLIF(:repository, ''), :environment) AS text)`,
        { actor, organization, project, id, name, kind, repository, environment }, JSON.parse);
    }
  };
}

const {
  CLOUD_SITE_ORIGIN, CLOUD_EVALUATORS, CLOUD_EDGE_KEY, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID,
  CLOUD_DB_CLUSTER_ARN, CLOUD_DB_RUNTIME_SECRET_ARN, CLOUD_DB_NAME
} = process.env;
if (!CLOUD_EDGE_KEY) throw new Error("The Cloud edge key is required");

export const handler = createAccountHandler({
  origin: CLOUD_SITE_ORIGIN,
  edgeKey: CLOUD_EDGE_KEY,
  consoleHtml: readFileSync(new URL("./mission-control.html", import.meta.url), "utf8"),
  evaluatorEmails: (CLOUD_EVALUATORS ?? "").split(",").filter(Boolean),
  identity: createCognitoIdentity({
    userPoolId: COGNITO_USER_POOL_ID, clientId: COGNITO_CLIENT_ID
  }),
  records: createAccountRecords({
    resourceArn: CLOUD_DB_CLUSTER_ARN, secretArn: CLOUD_DB_RUNTIME_SECRET_ARN, database: CLOUD_DB_NAME
  })
});
