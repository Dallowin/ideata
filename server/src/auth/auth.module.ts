import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AccountController } from './account.controller';
import { TelegramLoginController } from './telegram-login.controller';
import { EmailVerifyController } from './email-verify.controller';
import { SettingsController } from './settings.controller';
import { AuthResolver } from './auth.resolver';
import { AuthService } from './auth.service';
import { EmailVerifyService } from './email-verify.service';
import { LoginThrottleService } from './login-throttle.service';
import { CaptchaService } from './captcha.service';
import { LoginGuard, PaidPlanGuard } from './login.guard';
import { PlanGuard } from './plan.guard';
import { AdminGuard } from './admin.guard';

@Module({
  controllers: [
    AuthController,
    AccountController,
    TelegramLoginController,
    EmailVerifyController,
    SettingsController,
  ],
  providers: [
    AuthService,
    EmailVerifyService,
    AuthResolver,
    LoginThrottleService,
    CaptchaService,
    LoginGuard,
    PaidPlanGuard,
    PlanGuard,
    AdminGuard,
  ],
  exports: [AuthService, EmailVerifyService, LoginGuard, PaidPlanGuard, PlanGuard],
})
export class AuthModule {}
