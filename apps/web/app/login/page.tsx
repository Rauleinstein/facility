import { ButtonLink } from "@facility/ui";
import { ErrorNotice, Offline } from "@/components/offline";
import { api } from "@/lib/api";

const EXTERNAL_LABEL = { github: "continue with GitHub", oidc: "continue with SSO" } as const;

export default async function LoginPage() {
  const methods = await api.authMethods();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-10 px-6">
      <div className="flex flex-col gap-3">
        <span className="font-mono text-[22px] font-semibold tracking-tight">
          facility<span className="text-(--accent)">.</span>
        </span>
        <p className="text-sm leading-relaxed text-(--mut)">
          One persistent workspace and shared agent conversation for every story.
        </p>
      </div>

      {!methods.ok ? (
        methods.offline ? (
          <Offline />
        ) : (
          <ErrorNotice message={methods.message} />
        )
      ) : (
        <div className="flex flex-col gap-3">
          {methods.data.external ? (
            <ButtonLink href="/api/auth/login" variant="primary" size="lg">
              {EXTERNAL_LABEL[methods.data.external]}
            </ButtonLink>
          ) : null}
          {methods.data.local ? (
            <ButtonLink
              href="/api/auth/dev-login"
              variant={methods.data.external ? "outline" : "primary"}
              size="lg"
            >
              continue locally
            </ButtonLink>
          ) : null}
          {!methods.data.external && !methods.data.local ? (
            <ErrorNotice message="No sign-in method is configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET (or OIDC) on the API." />
          ) : null}
        </div>
      )}

      <p className="font-mono text-[10px] leading-relaxed text-(--dim)">
        An initiative by{" "}
        <a href="https://theagilemonkeys.com" className="underline-offset-4 hover:underline">
          The Agile Monkeys
        </a>
      </p>
    </div>
  );
}
