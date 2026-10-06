"""Shared validation for network IP details and capacity fields.

Used by the admin CRUD model (catalog.NetworkIn) and the inventory feed
model (inventory_plan.NetworkInv) so both accept exactly the same input.
"""

from ipaddress import IPv4Address, IPv4Network
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator

IP_FIELDS = ("subnet_cidr", "gateway", "ip_pool_start", "ip_pool_end")


def blank_to_none(value: Any) -> Any:
    return None if isinstance(value, str) and not value.strip() else value


def dns_list(value: Any) -> Any:
    """Accept a list or a comma/space separated string; validate each entry."""
    if value is None:
        return value
    if isinstance(value, str):
        value = [v for v in value.replace(",", " ").split() if v]
    return [str(IPv4Address(str(v).strip())) for v in value]


class NetworkIpFields(BaseModel):
    """Mixin: optional static addressing for a network (IPv4)."""

    subnet_cidr: IPv4Network | None = Field(None, description="e.g. 10.20.30.0/24")
    gateway: IPv4Address | None = None
    dns_domain: str = Field("", max_length=253)
    ip_pool_start: IPv4Address | None = Field(None, description="First address handed out to VMs")
    ip_pool_end: IPv4Address | None = Field(None, description="Last address handed out to VMs")

    @field_validator(*IP_FIELDS, mode="before")
    @classmethod
    def _blank(cls, v: Any) -> Any:
        return blank_to_none(v)

    @model_validator(mode="after")
    def _consistent(self) -> "NetworkIpFields":
        net = self.subnet_cidr
        if (self.ip_pool_start is None) != (self.ip_pool_end is None):
            raise ValueError("ip_pool_start and ip_pool_end must be given together")
        for name in ("gateway", "ip_pool_start", "ip_pool_end"):
            ip = getattr(self, name)
            if ip is not None and (net is None or ip not in net):
                raise ValueError(f"{name} must be inside subnet_cidr")
        if self.ip_pool_start and self.ip_pool_end and self.ip_pool_start > self.ip_pool_end:
            raise ValueError("ip_pool_start must not be after ip_pool_end")
        if self.gateway and self.ip_pool_start and self.ip_pool_start <= self.gateway <= self.ip_pool_end:
            raise ValueError("the gateway must not be inside the IP pool")
        return self

