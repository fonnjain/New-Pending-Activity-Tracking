import { useState } from "react";
import {
  useGetAuthStatus,
  useLogin,
  useLogout,
  useChangePassword,
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

export function LoginForm() {
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
          if (status === 401) {
            setError("Invalid email or password.");
          } else {
            setError(err?.message || "Login failed. Please try again.");
          }
        },
      },
    );
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="font-bold text-2xl text-primary tracking-tight">VTPL</div>
          <div className="text-muted-foreground text-sm mt-1">Production Activity Tracker</div>
        </div>
        <Card className="border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Lock className="w-5 h-5 text-primary" />
              Sign in to continue
            </CardTitle>
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
    </div>
  );
}

export function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const changePassword = useChangePassword();
  const queryClient = useQueryClient();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError("New passwords do not match.");
      return;
    }
    if (next.length < 6) {
      setError("New password must be at least 6 characters.");
      return;
    }
    changePassword.mutate(
      { data: { currentPassword: current, newPassword: next } },
      {
        onSuccess: () => {
          setSuccess(true);
          queryClient.invalidateQueries({ queryKey: getGetAuthStatusQueryKey() });
        },
        onError: (err) => {
          const status = (err as { status?: number })?.status;
          if (status === 401) {
            setError("Current password is incorrect.");
          } else {
            setError((err as { message?: string })?.message || "Failed to change password.");
          }
        },
      },
    );
  };

  if (success) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md text-center space-y-4">
          <p className="text-green-600 font-medium">Password changed. Loading your dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="font-bold text-2xl text-primary tracking-tight">VTPL</div>
          <div className="text-muted-foreground text-sm mt-1">Production Activity Tracker</div>
        </div>
        <Card className="border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Lock className="w-5 h-5 text-primary" />
              Set a new password
            </CardTitle>
            <p className="text-muted-foreground text-sm mt-1">
              You must set a new password before continuing.
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="cp-current">Current password</Label>
                <Input
                  id="cp-current"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cp-new">New password</Label>
                <Input
                  id="cp-new"
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cp-confirm">Confirm new password</Label>
                <Input
                  id="cp-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </div>
              {error && (
                <p className="text-sm font-medium text-destructive">{error}</p>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={changePassword.isPending}
              >
                {changePassword.isPending ? "Saving..." : "Set new password"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// Kept for pages that use admin-role checks (e.g. Data page shows an access
// denied card for non-admin authenticated users).
export function AccessDenied() {
  return (
    <div className="max-w-md mx-auto pt-16">
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Lock className="w-5 h-5 text-destructive" />
            Access restricted
          </CardTitle>
          <p className="text-muted-foreground text-sm mt-1">
            This area is only available to administrators.
          </p>
        </CardHeader>
      </Card>
    </div>
  );
}

// Legacy — keep export so existing import in data.tsx doesn't break until
// we update it.
export function LoginGate({ children }: { children: React.ReactNode }) {
  const { data } = useGetAuthStatus({
    query: { queryKey: getGetAuthStatusQueryKey() },
  });
  if (!data?.authenticated) return null;
  return <>{children}</>;
}
