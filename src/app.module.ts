import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { envValidationSchema } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { ApplicationsModule } from './applications/applications.module';
import { TodosModule } from './todos/todos.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    DatabaseModule,
    AuthModule,
    ApplicationsModule,
    TodosModule,
    DashboardModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
