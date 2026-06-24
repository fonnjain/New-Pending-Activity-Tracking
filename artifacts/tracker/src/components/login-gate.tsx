import { useState, type ReactNode } from "react";
import {
  useGetAuthStatus,
  useLogin,
  useLogout,
  getGetAuthStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock, LogOut } from "lucide-react";

export function LogoutButton() {
  const logout = useLogout();
  const queryClient = useQueryClient();
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-8 gap-2"
      disabled={logout.isPending}
      onClick={() =>
        logout.mutate(undefined, {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetAuthStatusQueryKey() });
          },
        })
      }
    >
      <LogOut className="w-4 h-4" /> Sign out
    </Button>
  );
}

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const login = useLogin();
  const queryClient = useQueryClient();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    login.mutate(
      { data: { email, password } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetAuthStatusQueryKey() });
        },
        onError: (err) => {
          const status = (err as { status?: number })?.status;
          if (status === 503) {
            setError("Login is not configured on the server.");
          } else if (status === 401) {
            setError("Invalid email or password.");
          } else {
            setError(err?.message || "Login failed. Please try again.");
          }
        },
      },
    );
  };

  return (
    <div className="max-w-md mx-auto pt-10">
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Lock className="w-5 h-5 text-primary" />
            Restricted Area
          </CardTitle>
          <p className="text-muted-foreground text-sm mt-1">
            The Data view is protected. Please sign in to upload reports and manage data.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="login-email">Email</Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && (
              <p className="text-sm font-medium text-destructive">{error}</p>
            )}
            <Button type="submit" className="w-full" disabled={login.isPending}>
              {login.isPending ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function LoginGate({ children }: { children: ReactNode }) {
  const { data, isLoading } = useGetAuthStatus({
    query: { queryKey: getGetAuthStatusQueryKey() },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center pt-20 text-muted-foreground text-sm">
        Checking access...
      </div>
    );
  }

  if (!data?.authenticated) {
    return <LoginForm />;
  }

  return <>{children}</>;
}
