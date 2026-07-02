import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { DevicePlatform } from '../user-device.entity';

const PLATFORMS: DevicePlatform[] = ['ios', 'android', 'web'];

export class RegisterDeviceDto {
  @IsNotEmpty()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  deviceToken!: string;

  @IsNotEmpty()
  @IsString()
  @IsIn(PLATFORMS)
  platform!: DevicePlatform;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  appVersion?: string;
}
