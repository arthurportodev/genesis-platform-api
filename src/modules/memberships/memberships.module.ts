import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Membership } from './entities/membership.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Membership])],
})
export class MembershipsModule {}
