-- REQ §13.154 (a): a saved request is repeating ('weekly', item 76) or a reservation for given dates ('dated').
create type public.template_schedule as enum ('weekly', 'dated');
