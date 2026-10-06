-- Starter global catalogs (operating systems, sizes, roles) so a fresh
-- environment is usable straight away. Admins can edit or archive these.
-- Idempotent: every insert is guarded by ON CONFLICT / NOT EXISTS.

INSERT INTO operating_systems (family, name, version, vmware_guest_id, created_by) VALUES
    ('windows', 'Windows Server', '2022', 'windows2019srvNext_64Guest', '739b29c7-f2e7-4b60-bf52-7be131b7ba27'),
    ('windows', 'Windows Server', '2019', 'windows2019srv_64Guest',     '739b29c7-f2e7-4b60-bf52-7be131b7ba27'),
    ('linux',   'Red Hat Enterprise Linux', '9', 'rhel9_64Guest',       '739b29c7-f2e7-4b60-bf52-7be131b7ba27'),
    ('linux',   'Ubuntu Server', '22.04', 'ubuntu64Guest',              '739b29c7-f2e7-4b60-bf52-7be131b7ba27')
ON CONFLICT ON CONSTRAINT operating_systems_name_version_uq DO NOTHING;

INSERT INTO vm_sizes (company_id, name, vcpu, cores_per_socket, ram_gb, created_by)
SELECT NULL, v.name, v.vcpu, v.cps, v.ram, '739b29c7-f2e7-4b60-bf52-7be131b7ba27'
FROM (VALUES ('Small', 2, 1, 4), ('Medium', 4, 2, 8), ('Large', 8, 4, 16), ('X-Large', 16, 8, 64))
     AS v(name, vcpu, cps, ram)
WHERE NOT EXISTS (SELECT 1 FROM vm_sizes s WHERE s.company_id IS NULL AND s.name = v.name);

INSERT INTO vm_roles (company_id, name, description, created_by)
SELECT NULL, v.name, v.description, '739b29c7-f2e7-4b60-bf52-7be131b7ba27'
FROM (VALUES ('Web server', 'Front-end web tier'),
             ('Application server', 'Middle-tier application host'),
             ('Database server', 'Relational database host'),
             ('Domain controller', 'Active Directory domain controller'))
     AS v(name, description)
WHERE NOT EXISTS (SELECT 1 FROM vm_roles r WHERE r.company_id IS NULL AND r.name = v.name);
